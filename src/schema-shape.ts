import type { z } from "zod";

/**
 * How this library reads the fields a schema *declares*, through whatever a
 * caller wrapped it in.
 *
 * `createCollection` enforces two rules where a schema is declared — no field
 * may shadow a where-clause combinator, and every non-identity field must carry
 * a `.default(...)` — and both rest on one question: which fields does this
 * schema declare? Each guard used to answer it by reading `schema.shape` and
 * treating an absent `.shape` as "nothing to enforce". That is true of
 * `z.string()`; it is not true of `z.object({…}).transform(…)`, `.pipe()` or a
 * union, which have fields and no `.shape`, so both guards silently did nothing
 * on a schema shaped that way (F020, #2). This module is the single reader they
 * both call instead.
 *
 * It is deliberately a *second* reader, not a reuse of `unwrapSchema` /
 * `declaredShape` in `collection.ts`. Those answer what a value honestly *is*
 * once every transform has run, which is why they refuse to follow
 * `.transform()`/`.pipe()`: past one of those, what a value is no longer matches
 * what the schema declared, and "undeclared" is the honest answer for the path
 * elision they serve. This one wants the declared shape and therefore follows
 * exactly those wrappers. Pointing either at the other's callers would be wrong
 * in both directions.
 *
 * Zod is a peer dependency across two majors whose internals differ, so every
 * read here covers both: Zod 4 keeps a schema's definition at `_zod.def` and Zod
 * 3 at `_def`, and their wrapper types do not line up key for key. Behaviour is
 * probed rather than read wherever a probe can answer — `hasDeclaredDefault`
 * asks the schema what it does with `undefined` rather than looking for a
 * `.default()` — and internals are read only where nothing else can say what a
 * wrapper wraps.
 */

/**
 * How many wrappers are peeled before a schema is treated as unreadable. A
 * malformed or self-referencing schema must not spin here, and no real schema
 * stacks anywhere near this many.
 */
export const MAX_WRAPPER_DEPTH = 10;

/**
 * The keys of a Zod schema definition this module reads, declared as what is
 * *read* rather than as what either major exposes. Every one of them is
 * optional because only one major, and only one wrapper type, ever carries it.
 */
interface SchemaDefinition {
  /** `.default()`, `.optional()`, `.nullable()`, `.catch()`, `.readonly()`. */
  innerType?: unknown;
  /** The declared input side of Zod 4's `ZodPipe` and Zod 3's `ZodPipeline`. */
  in?: unknown;
  /** Its output side — an object for a `.pipe()`, the transform for a `.transform()`. */
  out?: unknown;
  /** The wrapped schema of Zod 3's `ZodEffects` — `.transform()`, `.refine()`. */
  schema?: unknown;
  /** The branded schema under Zod 3's `ZodBranded`; a string type name under Zod 4. */
  type?: unknown;
  /** Zod 3's type tag, which is how a `ZodBranded` is told from a `ZodArray`. */
  typeName?: unknown;
  /** The deferred schema of `z.lazy()`. */
  getter?: unknown;
  /** The branches of a union or a discriminated union. */
  options?: unknown;
  /** The halves of an intersection. */
  left?: unknown;
  right?: unknown;
}

/** A schema's definition object, or `undefined` for anything that is not one. */
function readDefinition(schema: unknown): SchemaDefinition | undefined {
  return (
    (schema as { _zod?: { def?: SchemaDefinition } } | undefined)?._zod?.def ??
    (schema as { _def?: SchemaDefinition } | undefined)?._def
  );
}

/**
 * The schema one wrapper wraps, or `undefined` when this is not a wrapper.
 *
 * A pipe is followed on its **declared input side**: that is the shape an
 * already-stored row is parsed against, which is the side the declared-default
 * rule is about. A `.pipe()` whose output object renames or adds fields is
 * therefore read here as what it accepts rather than as what it produces —
 * `readDeclaredFieldNames` below reads both sides for the guard that needs
 * them.
 *
 * Zod 3's `ZodBranded` keeps its schema under `type`, which Zod 4 uses for a
 * type *name* and Zod 3's `ZodArray` uses for its element — so that key is only
 * followed behind the type tag that makes it unambiguous. An array is not a
 * wrapper here: it holds elements, not the fields of the document being
 * declared.
 */
export function innerDeclaredSchema(schema: unknown): unknown {
  const definition = readDefinition(schema);
  if (definition === undefined) return undefined;
  if (definition.innerType !== undefined) return definition.innerType;
  if (definition.in !== undefined) return definition.in;
  if (definition.schema !== undefined) return definition.schema;
  if (definition.typeName === "ZodBranded") return definition.type;
  if (typeof definition.getter === "function") {
    return (definition.getter as () => unknown)();
  }
  return undefined;
}

/**
 * The branches of a schema that composes several others — a union, a
 * discriminated union, an intersection — or `undefined` for anything else.
 * Such a schema may well declare fields, but not as one shape any single
 * `.shape` can carry, which is what `readObjectShape` answers `"opaque"` for.
 */
function compositeBranches(definition: SchemaDefinition | undefined): unknown[] | undefined {
  if (definition === undefined) return undefined;
  if (Array.isArray(definition.options)) return definition.options;
  if (definition.left !== undefined && definition.right !== undefined) {
    return [definition.left, definition.right];
  }
  return undefined;
}

/**
 * What reading a schema's declared fields produced.
 *
 * The three answers are distinct on purpose, because two of them used to be one:
 * "this schema declares no fields" and "this schema declares fields I cannot
 * read" were both answered by skipping, so a union of two object schemas was
 * waved through on the same terms as `z.string()`.
 */
export type SchemaShape =
  /** The fields the schema declares, keyed by name. */
  | { kind: "declared"; shape: Record<string, z.ZodType> }
  /** No fields to enforce anything about — `z.string()`, `z.record()`, `z.array()`. */
  | { kind: "none" }
  /** Fields exist, but not as a shape this library can read — a union, an intersection. */
  | { kind: "opaque" };

/**
 * Read the fields a schema declares, following the wrappers that keep an object
 * underneath: `.transform()`, `.pipe()`, `.brand()`, `.refine()`, `.optional()`,
 * `.nullable()`, `.default()`, `.catch()`, `.readonly()`, `z.lazy()`.
 */
export function readObjectShape(schema: unknown, depth = 0): SchemaShape {
  // Past the bound the schema is not unreadable in principle, only unread — so
  // it answers "opaque" rather than "none", and the caller refuses instead of
  // enforcing nothing.
  if (depth >= MAX_WRAPPER_DEPTH) return { kind: "opaque" };

  const shape = (schema as { shape?: Record<string, z.ZodType> } | undefined)?.shape;
  if (typeof shape === "object" && shape !== null) return { kind: "declared", shape };

  const branches = compositeBranches(readDefinition(schema));
  if (branches !== undefined) {
    // A union of scalars declares no fields and is as skippable as a scalar; a
    // union with an object anywhere in it does declare fields, and this reader
    // cannot merge them into one shape.
    const readings = branches.map((branch) => readObjectShape(branch, depth + 1));
    return readings.some((reading) => reading.kind !== "none")
      ? { kind: "opaque" }
      : { kind: "none" };
  }

  const inner = innerDeclaredSchema(schema);
  if (inner === undefined) return { kind: "none" };
  return readObjectShape(inner, depth + 1);
}

/**
 * Every field name a schema declares on **either** side of a pipe, for the
 * guard that cares about names rather than about the schemas behind them.
 *
 * A stored row is parsed against the input side, but what `insert` writes is the
 * *output*, so a name the where-grammar reserves matters wherever it appears. A
 * `.pipe(input, output)` therefore contributes both shapes; a `.transform()`
 * contributes only its input, because its output side is a function and no
 * reader can say what a function returns without running it. That residue is
 * disclosed where the guard is documented rather than claimed closed.
 *
 * A composite (a union, an intersection) contributes nothing, exactly as
 * `readObjectShape` answers `"opaque"` for one: such a schema only reaches a
 * collection under `{ enforceDefaults: false }`, where its field names are the
 * caller's.
 */
export function readDeclaredFieldNames(schema: unknown, depth = 0): string[] {
  if (depth >= MAX_WRAPPER_DEPTH) return [];

  const shape = (schema as { shape?: Record<string, z.ZodType> } | undefined)?.shape;
  if (typeof shape === "object" && shape !== null) return Object.keys(shape);

  const definition = readDefinition(schema);
  if (definition !== undefined && (definition.in !== undefined || definition.out !== undefined)) {
    return [
      ...readDeclaredFieldNames(definition.in, depth + 1),
      ...readDeclaredFieldNames(definition.out, depth + 1),
    ];
  }

  const inner = innerDeclaredSchema(schema);
  return inner === undefined ? [] : readDeclaredFieldNames(inner, depth + 1);
}

/**
 * Whether a field supplies a value of its own when the key is absent. Asked of
 * the schema by parsing `undefined` rather than by reading Zod internals, so it
 * holds across Zod 3 and Zod 4 and across `.default()`, `.catch()`, and a
 * default carried through a `.transform()`. `.optional()` answers `undefined`
 * and is therefore *not* a default: `JSON.stringify` drops the key outright.
 */
export function hasDeclaredDefault(schema: unknown): boolean {
  const parse = (schema as { safeParse?: (value: unknown) => { success: boolean; data?: unknown } })
    ?.safeParse;
  if (typeof parse !== "function") return false;
  const probe = parse.call(schema, undefined);
  return probe.success && probe.data !== undefined;
}
