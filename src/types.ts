// Internal, computed query shapes. These are assembled inside the process from
// already-validated inputs and never re-enter from outside, so they are the
// deliberate exception to Zod owning every shape: plain TypeScript types rather
// than Zod schemas.

/** A scalar value that can be bound to a SQLite parameter slot. */
export type SqlParameter = string | number | null;

/**
 * The set of comparison operators a field condition may use. Each maps to a
 * SQLite predicate over the field's `json_extract` expression.
 */
export interface FieldOperators<TValue> {
  /** Equal. `eq: null` compiles to `IS NULL`. */
  eq?: TValue;
  /** Not equal. `ne: null` compiles to `IS NOT NULL`. */
  ne?: TValue;
  /** Greater than. */
  gt?: TValue;
  /** Greater than or equal. */
  gte?: TValue;
  /** Less than. */
  lt?: TValue;
  /** Less than or equal. */
  lte?: TValue;
  /** Membership. An empty list matches nothing. */
  in?: readonly TValue[];
  /** Exclusion. An empty list matches everything. */
  notIn?: readonly TValue[];
  /**
   * A **raw** SQL `LIKE` pattern (string fields), the expert escape hatch:
   * `%` and `_` in the operand are wildcards. The compiled predicate declares
   * `ESCAPE '\'`, so `\%` and `\_` match those characters literally — and, by
   * the same rule, a literal backslash must be written `\\`. For an operand
   * that comes from a user — a search box — use `contains`, `startsWith`, or
   * `endsWith` instead, which escape it for you.
   */
  like?: string;
  /** Substring match. The operand is escaped, so `%` and `_` are literal. */
  contains?: string;
  /** Prefix match. The operand is escaped, so `%` and `_` are literal. */
  startsWith?: string;
  /** Suffix match. The operand is escaped, so `%` and `_` are literal. */
  endsWith?: string;
  /** `isNull: true` compiles to `IS NULL`, `false` to `IS NOT NULL`. */
  isNull?: boolean;
}

/**
 * A single field's condition: either a bare value (shorthand for `{ eq: value }`)
 * or an operator object.
 */
export type FieldCondition<TValue> = TValue | FieldOperators<TValue>;

/**
 * Whether a field's value is a nested document worth descending into for a
 * dotted path. Arrays, dates, and functions are not: `json_extract` addresses
 * array elements by index rather than by name, and a `Date`'s keys are methods.
 */
type NestedDocument<TValue> = NonNullable<TValue> extends readonly unknown[]
  ? never
  : NonNullable<TValue> extends Date
    ? never
    : NonNullable<TValue> extends (...args: never[]) => unknown
      ? never
      : NonNullable<TValue> extends object
        ? NonNullable<TValue>
        : never;

/**
 * How deep a dotted path may go: three levels, `a`, `a.b`, `a.b.c`. The bound
 * exists because an unbounded recursive conditional hits TypeScript's
 * instantiation limit on a deeply nested schema; three levels covers every
 * document shape this store is meant to hold. Deeper paths still work at
 * runtime — `jsonExtract` validates any dotted identifier chain — they are
 * simply not reachable through the typed surface.
 */
type PathDepthBudget = [unknown, unknown, unknown];

/**
 * Every field path of a document that a `where` or `orderBy` may address: each
 * top-level field, plus dotted paths into nested objects up to
 * {@link PathDepthBudget}. This is the same path vocabulary `jsonExtract`
 * accepts and `IndexDefinition.fields` documents.
 */
export type FieldPath<
  TDocument,
  TDepth extends unknown[] = PathDepthBudget,
> = TDepth extends [unknown, ...infer TRemaining extends unknown[]]
  ? {
      [Field in keyof TDocument & string]:
        | Field
        | (NestedDocument<TDocument[Field]> extends never
            ? never
            : `${Field}.${FieldPath<NestedDocument<TDocument[Field]>, TRemaining>}`);
    }[keyof TDocument & string]
  : never;

/** The type of the value a {@link FieldPath} resolves to. */
export type ValueAtPath<TDocument, TPath> = TPath extends `${infer Head}.${infer Rest}`
  ? Head extends keyof TDocument
    ? ValueAtPath<NonNullable<TDocument[Head]>, Rest>
    : never
  : TPath extends keyof TDocument
    ? TDocument[TPath]
    : never;

/**
 * A typed where-clause over a document type. Every key is a field path of the
 * document — a top-level field or a dotted path into a nested object; every
 * value is a condition on that path. Conditions are combined with `AND`.
 *
 * Two reserved keys combine clauses instead of naming a field: `OR` holds
 * alternatives (an empty list matches nothing), `NOT` negates one nested
 * clause. Both nest arbitrarily. They are uppercase so they cannot be mistaken
 * for a field, and `createCollection` refuses an **object** schema carrying a
 * field named `OR` or `NOT`. A schema with no readable shape — one wrapped in
 * `.transform()`, `.pipe()`, a union — is not walked, so the guard is a strong
 * default rather than a proof.
 */
export type Where<TDocument> = {
  [Path in FieldPath<TDocument>]?: FieldCondition<ValueAtPath<TDocument, Path>>;
} & {
  /** Alternatives, joined with `OR`. An empty list matches nothing. */
  OR?: Where<TDocument>[];
  /** One nested clause, negated. */
  NOT?: Where<TDocument>;
};

/** Sort direction for an `orderBy` clause. */
export type SortDirection = "asc" | "desc";

/** A single ordering instruction over a document field path. */
export interface OrderBy<TDocument> {
  field: FieldPath<TDocument>;
  direction?: SortDirection;
}

/** Options accepted by `find` / `findOne` / `count`. */
export interface QueryOptions<TDocument> {
  where?: Where<TDocument>;
  orderBy?: OrderBy<TDocument> | OrderBy<TDocument>[];
  limit?: number;
  offset?: number;
}

/** Declaration of a single expression index over one or more document fields. */
export interface IndexDefinition {
  /** Dotted field paths to index, e.g. `["status"]` or `["address.city"]`. */
  fields: string[];
  /** Whether the index enforces uniqueness. Defaults to `false`. */
  unique?: boolean;
}

/** An index declaration: a bare field path or a full definition. */
export type IndexInput = string | IndexDefinition;
