import type { z } from "zod";

/**
 * How this library reads the fields a schema *declares*, through whatever a
 * caller wrapped it in.
 *
 * `createCollection` enforces two rules where a schema is declared — no field
 * may shadow a where-clause combinator, and every non-identity field must carry
 * a `.default(...)` — and both rest on one question: which fields does this
 * schema declare? (The defaults rule asks it recursively, so this module also
 * answers the neighbouring one: what does a container declare its stored
 * *members* under — see `readContainedSchemas`.) Each guard used to answer it
 * by reading `schema.shape` and
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
  /** The element schema of Zod 4's `ZodArray` — Zod 3 keeps it under `type`. */
  element?: unknown;
  /** The value schema of a record, on both majors. */
  valueType?: unknown;
  /** The positional member schemas of a tuple, on both majors. */
  items?: unknown;
  /** The schema a tuple's trailing positions are parsed against, on both majors. */
  rest?: unknown;
  /** The schema an object's undeclared keys are parsed against — `.catchall()`. */
  catchall?: unknown;
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
 * One schema that a *stored member* of a container is parsed against, and how
 * that member is named in a field path.
 *
 * A container mostly declares no fields of its own — `readObjectShape` answers
 * `"none"` for an array, a record and a tuple — but what it stores is parsed
 * against a declared schema all the same, so a rule about "what an
 * already-stored value is parsed against" reaches through it. An object with a
 * `.catchall()` is both at once: it declares fields *and* stores members under a
 * second schema, so it is read by both readers. The `kind` is what the caller
 * renders the path segment from; the reader does not spell paths.
 */
export interface ContainedSchema {
  /**
   * `element` for an array member and for a tuple's `rest` tail, which is an
   * array of the same shape; `item` for a declared tuple position; `value` for a
   * record's values and for an object's `.catchall()` keys, both of which are
   * keyed by the caller's data rather than by a declared name.
   */
  kind: "element" | "item" | "value";
  /** The tuple position, and `null` for the kinds that have none. */
  position: number | null;
  schema: unknown;
}

/**
 * Zod 4 tags a schema's kind with a string under `type`; Zod 3 with a type name
 * under `typeName`. Zod 3's `ZodArray` also uses `type` — for its *element
 * schema* — so the string check is what keeps the two readings apart.
 */
function schemaTag(definition: SchemaDefinition): string | undefined {
  if (typeof definition.type === "string") return definition.type;
  return typeof definition.typeName === "string" ? definition.typeName : undefined;
}

/**
 * The schemas a container stores its members under, through whatever wrappers
 * the container carries (`z.array(…).default([])`), or `[]` for anything that is
 * not a container this library can read into.
 *
 * Every way a stored value reaches a schema *without* a declared field name is
 * read here — an array's elements, a tuple's declared positions **and its `rest`
 * tail**, a record's values, and an object's **`.catchall()`**. A shape missed
 * here is a shape the defaults rule silently stops at, which is the failure this
 * reader exists to end, so the set is enumerated rather than sampled.
 *
 * `z.map()` and `z.set()` are deliberately **not** read: neither survives the
 * JSON round-trip the write gate enforces, so no such field can reach storage in
 * the first place and there is no stored member to hold to a rule.
 */
export function readContainedSchemas(schema: unknown, depth = 0): ContainedSchema[] {
  if (depth >= MAX_WRAPPER_DEPTH) return [];

  const definition = readDefinition(schema);
  if (definition === undefined) return [];

  switch (schemaTag(definition)) {
    case "array":
    case "ZodArray": {
      // Zod 4 keeps the element under `element`, Zod 3 under `type`.
      const element = definition.element ?? definition.type;
      return element === undefined ? [] : [{ kind: "element", position: null, schema: element }];
    }
    case "record":
    case "ZodRecord": {
      const value = definition.valueType;
      return value === undefined ? [] : [{ kind: "value", position: null, schema: value }];
    }
    case "tuple":
    case "ZodTuple": {
      const items = Array.isArray(definition.items) ? definition.items : [];
      const contained: ContainedSchema[] = items.map((item, position) => ({
        kind: "item",
        position,
        schema: item,
      }));
      // A `rest` is the tail past the declared positions — an array's worth of
      // one shape, and stored exactly like one. Both majors leave it `null` when
      // the tuple has none.
      if (definition.rest !== undefined && definition.rest !== null) {
        contained.push({ kind: "element", position: null, schema: definition.rest });
      }
      return contained;
    }
    case "object":
    case "ZodObject": {
      // An object's declared fields are `readObjectShape`'s to hold to the rule;
      // what a `.catchall()` accepts under the keys it does *not* declare is
      // stored the same way a record's values are. Zod 3 gives every object a
      // `ZodNever` catchall, which declares nothing and costs one empty read.
      const catchall = definition.catchall;
      return catchall === undefined ? [] : [{ kind: "value", position: null, schema: catchall }];
    }
    default:
      break;
  }

  const inner = innerDeclaredSchema(schema);
  return inner === undefined ? [] : readContainedSchemas(inner, depth + 1);
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
