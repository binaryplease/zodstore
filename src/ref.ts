import { z } from "zod";
import {
  hasDeclaredDefault,
  innerDeclaredSchema,
  MAX_WRAPPER_DEPTH,
} from "./schema-shape.ts";

/**
 * The mark every schema `ref()` hands out carries, so a collection can tell an
 * identity field from an ordinary one without matching on field names.
 *
 * It sits on the schema's *definition* rather than in a set of schema objects,
 * because Zod schemas are immutable: every chained method returns a new object,
 * so a `WeakSet` of the objects `ref()` returned answered `false` for
 * `ref("user").nullable()` — and for `ref("user").describe("…")`, which changes
 * nothing about the field at all (F044, #7). Both peer majors build a chained
 * schema by copying the definition it was chained from, so a mark placed there
 * survives the copy; the wrappers that build a *new* definition around the old
 * one (`.nullable()`, `.optional()`) are followed in `isReference` below.
 *
 * Registered globally by key rather than held as a module-local symbol, so two
 * copies of this library in one process still recognise each other's
 * references — the same reason Zod itself is a peer dependency here.
 */
const REFERENCE_MARK = Symbol.for("@binaryplease/zodstore.reference");

/** Definitions this module writes its mark onto, on either peer major. */
type MarkableDefinition = Record<symbol, unknown>;

function readDefinition(schema: unknown): MarkableDefinition | undefined {
  return (
    (schema as { _zod?: { def?: MarkableDefinition } } | undefined)?._zod?.def ??
    (schema as { _def?: MarkableDefinition } | undefined)?._def
  );
}

/**
 * Whether a schema is one `ref()` produced, or a copy of one — as opposed to a
 * wrapper around one, which `isReference` peels before asking.
 */
function carriesReferenceMark(schema: unknown): boolean {
  return readDefinition(schema)?.[REFERENCE_MARK] === true;
}

/**
 * Whether a schema describes an identity-shaped field — one `ref()` produced,
 * or one wrapped in something that leaves its identity intact — and is
 * therefore exempt from the declared-default rule.
 *
 * `.nullable()`, `.optional()`, `.describe()`, `.brand()` and `.refine()` all
 * keep the exemption: an optional relation is the ordinary shape of a foreign
 * key, and documentation is not a change of shape.
 *
 * A wrapper that **supplies a value of its own** ends it. `ref("user")
 * .default("user_fallback")` is a field that invents a reference when none is
 * given, which is the thing the exemption exists to prevent; it is also a field
 * that declares a default, so it satisfies the rule on its own merits rather
 * than through an exception. The boundary is drawn by asking the schema what it
 * does with an absent value, not by matching wrapper names, so it holds across
 * both peer majors.
 */
export function isReference(schema: z.ZodType): boolean {
  let current: unknown = schema;
  for (let depth = 0; depth < MAX_WRAPPER_DEPTH; depth += 1) {
    if (carriesReferenceMark(current)) return true;
    if (hasDeclaredDefault(current)) return false;
    const inner = innerDeclaredSchema(current);
    if (inner === undefined) return false;
    current = inner;
  }
  return false;
}

/**
 * Schema helper for a typed foreign-key reference. A reference is the string id
 * of a document in another collection, conventionally prefixed (e.g. a `user`
 * reference looks like `user_a1b2c3`). Declaring foreign keys with `ref` means
 * they are validated at the Zod gate alongside the rest of the document, and a
 * malformed reference fails loudly on the way in rather than dangling silently.
 *
 * The reference is identity-shaped (it points at another row's primary key), so
 * it carries no default and must be supplied at creation. That exemption from
 * the declared-default rule survives the wrappers that leave identity intact —
 * `.nullable()`, `.optional()`, `.describe()`, `.brand()`, `.refine()` — so a
 * nullable foreign key is written as it reads:
 *
 * ```ts
 * z.object({ id: ref("post"), authorId: ref("user").nullable() });
 * ```
 *
 * Prefer `.nullable()` over `.optional()` for a *stored* reference. Both keep
 * the exemption, but an absent optional is dropped from the row by
 * `JSON.stringify`, so the stored key set varies row to row — the very
 * incompleteness the declared-default rule exists to prevent — while a nullable
 * one stores the explicit `null`.
 *
 * A `.default(...)` on a reference is **not** identity-shaped any more: it
 * invents a reference to a row that may not exist, which is what the exemption
 * exists to prevent. Such a field is held to the ordinary rule instead — and it
 * passes, because it declares a default.
 *
 * @example
 *   const PostSchema = z.object({
 *     id: ref("post"),
 *     authorId: ref("user"),
 *     editorId: ref("user").nullable(),
 *     title: z.string().default(""),
 *   });
 */
export function ref(prefix: string): z.ZodString {
  if (prefix.length === 0) {
    throw new Error("ref(prefix): prefix must not be empty");
  }
  const schema = z
    .string()
    .startsWith(`${prefix}_`, `must be a "${prefix}" reference (expected "${prefix}_…")`);
  const definition = readDefinition(schema);
  if (definition === undefined) {
    // Loudly, at the edge: without the mark the collection guard would demand a
    // default of every foreign key, which is the failure this replaced.
    throw new Error(
      `ref("${prefix}"): cannot mark the schema as a reference — the installed Zod ` +
        `exposes neither "_zod.def" nor "_def". The supported peer range is ` +
        `"^3.24.0 || ^4.3".`,
    );
  }
  definition[REFERENCE_MARK] = true;
  return schema;
}
