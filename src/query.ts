import { CANONICAL_ISO_LENGTH } from "./date.ts";
import type {
  FieldOperators,
  OrderBy,
  SortDirection,
  SqlParameter,
} from "./types.ts";

/** A fragment of SQL together with the parameters it binds, in order. */
export interface CompiledClause {
  sql: string;
  parameters: SqlParameter[];
}

/**
 * Every operator the where-grammar declares, as a record **keyed by
 * `FieldOperators`** — which is what couples the two (F050). An operator added
 * to that interface and forgotten here is a missing property, so `tsc` names it;
 * before, the two lists were related only by the set's type parameter, which
 * catches a typo and not an omission. `KNOWN_OPERATORS` is derived from it
 * rather than written out beside it, because a second literal list in the same
 * file is the same defect at a shorter distance.
 */
const OPERATOR_NAMES: Record<keyof FieldOperators<unknown>, true> = {
  eq: true,
  ne: true,
  gt: true,
  gte: true,
  lt: true,
  lte: true,
  in: true,
  notIn: true,
  like: true,
  contains: true,
  startsWith: true,
  endsWith: true,
  isNull: true,
};

const KNOWN_OPERATORS: ReadonlySet<string> = new Set(Object.keys(OPERATOR_NAMES));

/**
 * The reserved `where` keys that combine clauses instead of naming a field.
 *
 * One declaration, because two files have to agree about it (F051). The
 * constants `compileConditions` branches on are read out of this list, and
 * {@link RESERVED_WHERE_KEYS} is the same list as a set — so a combinator added
 * here reaches `createCollection`'s schema guard without anybody remembering to
 * edit a second literal in a second file. A field name that shadows a
 * combinator can never be filtered on, so that guard is what keeps the
 * shadowing from surfacing as a silently mis-compiled filter, and it used to be
 * correct only for as long as the two lists happened to agree.
 */
const COMBINATOR_KEYS = ["OR", "NOT"] as const;
const [OR_KEY, NOT_KEY] = COMBINATOR_KEYS;

/**
 * The `where` keys that name a combinator rather than a document field. Read by
 * `src/collection.ts`, which refuses a schema declaring a field of the same
 * name. Internal to the library: `src/index.ts` does not re-export it, because
 * it describes this module's grammar rather than the library's surface.
 */
export const RESERVED_WHERE_KEYS: ReadonlySet<string> = new Set(COMBINATOR_KEYS);

const FIELD_PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/**
 * The escape character declared by every `LIKE` this module emits. A backslash
 * carries no special meaning inside a SQLite string literal, so `'\'` is one
 * backslash and needs no doubling.
 */
const LIKE_ESCAPE_CLAUSE = String.raw`ESCAPE '\'`;

/**
 * Neutralise the `LIKE` wildcards in an operand so it matches literally. The
 * escape character itself goes first, or escaping `%` would produce a pattern
 * whose backslash is then read as an escape of its own.
 */
function escapeLikeOperand(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/**
 * Name an operand's type for an error message. `typeof null` is `"object"`,
 * which is the least useful answer at exactly the moment a caller needs one.
 */
function describeOperand(operand: unknown): string {
  if (operand === null) return "null";
  if (Array.isArray(operand)) return "an array";
  return typeof operand;
}

/** Read a `contains`/`startsWith`/`endsWith` operand, which must be a string. */
function readPatternOperand(operator: string, operand: unknown): string {
  if (typeof operand !== "string") {
    throw new Error(
      `Operator "${operator}" expects a string operand, got ${describeOperand(operand)}`,
    );
  }
  return escapeLikeOperand(operand);
}

/**
 * Read an `isNull` operand, which must be the `boolean` `FieldOperators`
 * declares — not merely something JavaScript calls truthy (F046).
 *
 * The branch this guards is a ternary, so every truthy operand used to select
 * `IS NULL` and every falsy one `IS NOT NULL`. `isNull: "false"` — what a query
 * string yields for `?isNull=false` before anything parses it — therefore
 * returned exactly the rows `isNull: false` was asked to exclude, and on
 * `deleteMany` deleted the complement of what the caller named. An operator that
 * inverts under a type the language calls truthy is worse than one that throws.
 */
function readBooleanOperand(operator: string, operand: unknown): boolean {
  if (typeof operand !== "boolean") {
    throw new Error(
      `Operator "${operator}" expects a boolean operand, got ${describeOperand(operand)}`,
    );
  }
  return operand;
}

/**
 * Read a `gt`/`gte`/`lt`/`lte` operand, which must name a value to order
 * against. `null` is not one (F046): every SQL range comparison against `NULL`
 * evaluates to unknown rather than true, and a `WHERE` keeps only what is true,
 * so `gt: null` compiled to a `> ?` that matched no row and said nothing about
 * why — an empty answer indistinguishable from a truthful one.
 */
function readOrderedOperand(operator: string, operand: unknown): unknown {
  if (operand === null) {
    throw new Error(
      `Operator "${operator}" expects a value to order against, got null: a range ` +
        `comparison against no value has no answer — use "isNull" or "eq: null" ` +
        `to name the rows that have no value`,
    );
  }
  return operand;
}

/** Read an `in`/`notIn` operand, which must be a list of values. */
function readListOperand(operator: string, operand: unknown): readonly unknown[] {
  if (!Array.isArray(operand)) {
    throw new Error(
      `Operator "${operator}" expects an array operand, got ${describeOperand(operand)}`,
    );
  }
  return operand;
}

/**
 * Build the SQLite JSON path expression for a (possibly dotted) field path. The
 * path is validated against a strict identifier pattern so it can be embedded in
 * the SQL string without opening an injection vector — values always travel as
 * bound parameters, never field names.
 */
export function jsonExtract(fieldPath: string): string {
  if (!FIELD_PATH_PATTERN.test(fieldPath)) {
    throw new Error(
      `Invalid field path "${fieldPath}": only identifiers and dots are allowed`,
    );
  }
  return `json_extract(doc, '$.${fieldPath}')`;
}

/**
 * Convert a JavaScript value into the form SQLite compares against a
 * `json_extract` result. JSON booleans surface as integers `1`/`0`, so booleans
 * are mapped accordingly; a `Date` binds as the ISO string it is stored as;
 * everything else binds as-is.
 *
 * The `Date` mapping is what makes a `dateParser` field queryable through the
 * typed surface (F029): `JSON.stringify` stores a `Date` via its `toJSON` —
 * `toISOString()` — and equal-length ISO-8601 UTC strings order
 * lexicographically exactly as their instants order chronologically, so the
 * bound form compares against the stored form under every operator, including
 * `ORDER BY`. Equal-length is load-bearing, so it is enforced rather than
 * assumed: outside years 0000–9999 `toISOString()` switches to the expanded
 * form (`+275760-…`), whose leading sign sorts before every digit and would
 * order wrongly against every in-range value — `dateParser` refuses to store
 * such a date, and the same range is refused here on the operand. An invalid
 * `Date` denotes no instant to compare against, so it too is refused by name
 * rather than left to `toISOString()`'s opaque `RangeError`. `context` names
 * the operator or field at fault, because a `where` can carry several date
 * conditions and a message that names none of them makes the caller bisect.
 *
 * `NaN` is refused for the same stated reason as an invalid `Date`, and it is
 * the number `Number(badQueryParam)` produces (F046): `bun:sqlite` binds it as
 * SQL `NULL`, every comparison against `NULL` is unknown, and the filter then
 * returns an empty answer no caller can tell apart from a truthful one.
 * **`Infinity` and `-Infinity` pass**, decided rather than inherited: they bind
 * as REAL and order against every stored number, so `lt: Infinity` is the
 * working "any number" filter it looks like, and refusing it would remove a
 * query that answers correctly rather than a way to spell a mistake. Neither is
 * ever a *stored* value — `JSON.stringify` maps every non-finite number to
 * `null`, which is why the write gate's round-trip check refuses to store one.
 */
function toSqlParameter(value: unknown, context: string): SqlParameter {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(
        `Invalid Date operand for ${context}: its time value is NaN, so it denotes no instant to compare against`,
      );
    }
    const isoForm = value.toISOString();
    if (isoForm.length !== CANONICAL_ISO_LENGTH) {
      throw new Error(
        `Invalid Date operand for ${context}: ${isoForm} lies outside years 0000–9999, ` +
          `whose expanded ISO form does not order against the stored form`,
      );
    }
    return isoForm;
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      throw new Error(
        `Invalid number operand for ${context}: NaN denotes no value to compare against, ` +
          `so every comparison it reaches is unknown and the filter can only answer nothing`,
      );
    }
    return value;
  }
  if (value === null || typeof value === "string") {
    return value;
  }
  throw new Error(
    `Unsupported filter value of type ${typeof value}: where-clauses compare scalar fields only`,
  );
}

/**
 * The JSON text SQLite's parser reads back as `+Infinity` and `-Infinity`.
 *
 * `JSON.stringify` has no spelling for a non-finite number — it emits `null` —
 * and `toSqlParameter` passes both infinities deliberately, so a list carrying
 * one cannot be serialised naively. The consequence would not be a near miss: a
 * `null` inside the array a `NOT IN` reads makes that predicate unknown for
 * every row, turning `notIn: [Infinity]` from "every row" into "no row". An
 * out-of-range exponent is well-formed JSON, SQLite parses it to the REAL
 * infinity, and that value compares equal to a bound `Infinity` — so the list
 * survives the round trip with the membership answers it had as placeholders.
 */
const POSITIVE_INFINITY_JSON = "1e999";
const NEGATIVE_INFINITY_JSON = `-${POSITIVE_INFINITY_JSON}`;

/**
 * The membership test over `expression`, against a list bound as **one** JSON
 * array parameter rather than one placeholder per element (F027).
 *
 * A placeholder per element put the element *count* in the SQL text, so `in`
 * over three values and `in` over four were two different statements — and
 * `bun:sqlite` caches a prepared statement per distinct SQL string, with no
 * eviction, for the life of the `Database`. The list length is what an endpoint
 * forwards from `?ids=a,b,c`, so the cardinality of that cache was the caller's
 * to choose, and the cost is quadratic in the longest list seen: each retained
 * statement is itself proportional to its arity. One statement per operator now
 * covers every length, which also puts the list past the bound on how many
 * parameters a statement may carry — 65 535 on the SQLite Bun ships, measured
 * rather than assumed — since it binds as one parameter however long it is.
 *
 * The plan is the reason this shape is usable rather than merely tidy, and it
 * was measured before being chosen: `EXPLAIN QUERY PLAN` reports the same
 * `SEARCH … USING INDEX (id=?)` for the subquery form as for the placeholder
 * form, on the `id` primary key and on a declared `json_extract` expression
 * index alike. The suite asserts it, because the difference between this and a
 * table scan is one planner decision.
 */
export function compileMembership(expression: string, keyword: "IN" | "NOT IN"): string {
  return `${expression} ${keyword} (SELECT value FROM json_each(?))`;
}

/**
 * Serialise a list into the single parameter {@link compileMembership}'s
 * placeholder binds. Every element goes through `toSqlParameter` first, so the
 * bound array holds exactly the values the placeholder form bound, in the same
 * order and with the same refusals — a `Date` as its ISO string, a boolean as
 * `1`/`0`, `NaN` named as the mistake it is.
 *
 * This is still a bound parameter and not SQL: the array is one TEXT value
 * SQLite parses, so no element can reach the statement text however it is
 * spelled.
 *
 * Appended rather than mapped-and-joined because the intermediate array is the
 * larger allocation of the two on a long list, and this runs once per query on
 * lists whose length the caller chooses.
 */
export function encodeMembershipList(values: readonly unknown[], context: string): string {
  let encoded = "[";
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0) encoded += ",";
    const parameter = toSqlParameter(values[index], context);
    encoded +=
      typeof parameter === "number" && !Number.isFinite(parameter)
        ? parameter > 0
          ? POSITIVE_INFINITY_JSON
          : NEGATIVE_INFINITY_JSON
        : JSON.stringify(parameter);
  }
  return `${encoded}]`;
}

/**
 * Whether a field's condition is an operator object rather than a document value
 * compared for equality. Two tests, and both carry weight: the condition is a
 * **plain** object, and every key it has names an operator. The second is what
 * keeps a nested document (`{ city: "x" }`) on the value path where it belongs.
 *
 * `{}` counts, with no keys to name (F047). It used to fall through to the value
 * path and be reported as an unsupported *value* — a message about scalar
 * comparison, for a caller who supplied no condition at all. `{ ...(bound && {
 * gte: bound }) }` is the idiomatic optional filter and produces `{}` at exactly
 * its widest, so the shape is the default state of a filter screen rather than
 * an exotic one; `compileConditions` gives it the same fail-closed answer as the
 * sibling spelling `{ gte: undefined }`.
 *
 * Which is exactly why the first test has to be about the prototype rather than
 * about the key count. `{}` is not the only object with no own enumerable keys:
 * a `Date` is one too, and a `Date` is a *value* this compiler binds against a
 * stored ISO string (F029). Counting keys used to separate the two by accident;
 * once an empty condition is meaningful, the separation has to be stated.
 */
function isOperatorObject(condition: unknown): condition is FieldOperators<unknown> {
  if (condition === null || typeof condition !== "object") return false;
  const prototype = Object.getPrototypeOf(condition) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.keys(condition).every((key) => KNOWN_OPERATORS.has(key));
}

/**
 * Compile one operator into a boolean expression over `expression`, appending it
 * to `conditions` and its bound values to `parameters`.
 *
 * **The exclusion operators are total over the nullable domain (F042).** A row
 * whose stored value is SQL `NULL` is excluded from the named *set*, not from
 * the *answer*. Bare `<> ?` and `NOT IN (…)` evaluate to `NULL` — not true —
 * against a `NULL` left side, and a `WHERE` keeps only what evaluates to true,
 * so every null-valued row used to fall silently out of `ne` and `notIn`, and
 * out of the `deleteMany({ field: { ne: "keep" } })` retention sweep that spells
 * the same clause on the write path. Both now admit those rows explicitly.
 *
 * Two semantics that follow from it, stated here rather than left to be
 * discovered:
 *
 * - **A stored JSON `null` and an absent key stay indistinguishable.**
 *   `json_extract` returns SQL `NULL` for both, so every operator in this
 *   function reads them as one and the same "no value" — which is what
 *   `eq: null` and `isNull` already did.
 * - **A `null` inside an `in`/`notIn` list names that same "no value" as a
 *   member of the set**, rather than binding a parameter nothing can equal.
 *   `in: [null]` therefore means `eq: null` and `notIn: [null]` means
 *   `ne: null`, and the two operators stay exact complements at every list
 *   shape.
 *
 * Every compound predicate is emitted **already parenthesised**, because the
 * combinators nest it: a bare `expr IS NULL OR expr <> ?` binds loosely enough
 * under a sibling `AND`, an `OR` branch or a `NOT` to re-scope the clause it
 * sits in, which turns a narrowing filter into a widening one.
 */
function compileOperator(
  expression: string,
  operator: keyof FieldOperators<unknown>,
  operand: unknown,
  conditions: string[],
  parameters: SqlParameter[],
): void {
  switch (operator) {
    case "eq":
      if (operand === null) {
        conditions.push(`${expression} IS NULL`);
      } else {
        conditions.push(`${expression} = ?`);
        parameters.push(toSqlParameter(operand, `operator "${operator}"`));
      }
      return;
    case "ne":
      if (operand === null) {
        conditions.push(`${expression} IS NOT NULL`);
      } else {
        // A row with no value is not the named one, so it belongs in the answer.
        conditions.push(`(${expression} IS NULL OR ${expression} <> ?)`);
        parameters.push(toSqlParameter(operand, `operator "${operator}"`));
      }
      return;
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const ordered = readOrderedOperand(operator, operand);
      const sqlOperator = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[operator];
      conditions.push(`${expression} ${sqlOperator} ?`);
      parameters.push(toSqlParameter(ordered, `operator "${operator}"`));
      return;
    }
    case "in":
    case "notIn": {
      const values = readListOperand(operator, operand);
      if (values.length === 0) {
        // An empty `in` matches nothing; an empty `notIn` matches everything.
        conditions.push(operator === "in" ? "0" : "1");
        return;
      }
      // A `null` in the list names the rows that have no value — nothing a bound
      // parameter can equal, so it is carried by an `IS NULL` test instead of a
      // placeholder, and only the comparable values reach the `IN (…)`.
      const namesTheAbsence = values.some((value) => value === null);
      const comparableValues = values.filter((value) => value !== null);
      if (comparableValues.length === 0) {
        // The list named nothing but the absence, so that test is the whole
        // predicate: `in: [null]` is `eq: null`, `notIn: [null]` is `ne: null`.
        conditions.push(
          operator === "in" ? `${expression} IS NULL` : `${expression} IS NOT NULL`,
        );
        return;
      }
      // The comparable values travel as one bound JSON array, so the statement
      // is the same whatever the list's length (F027). The null-bearing forms
      // below are the second axis the same cache keys on, and they inherit the
      // property: two statements per operator now cover every list.
      const membership = compileMembership(expression, operator === "in" ? "IN" : "NOT IN");
      if (operator === "in") {
        conditions.push(
          namesTheAbsence ? `(${expression} IS NULL OR ${membership})` : membership,
        );
      } else {
        // `notIn` drops the null-valued rows only when the list named the
        // absence; otherwise they are outside the named set and the answer keeps
        // them, which a bare `NOT IN (…)` never did (F042).
        conditions.push(
          namesTheAbsence
            ? `(${expression} IS NOT NULL AND ${membership})`
            : `(${expression} IS NULL OR ${membership})`,
        );
      }
      parameters.push(encodeMembershipList(comparableValues, `operator "${operator}"`));
      return;
    }
    case "like":
      // The raw escape hatch: the operand's own wildcards are the point. The
      // ESCAPE clause is what lets an expert opt one out with a backslash.
      conditions.push(`${expression} LIKE ? ${LIKE_ESCAPE_CLAUSE}`);
      parameters.push(toSqlParameter(operand, `operator "${operator}"`));
      return;
    case "contains":
    case "startsWith":
    case "endsWith": {
      const escaped = readPatternOperand(operator, operand);
      const pattern = {
        contains: `%${escaped}%`,
        startsWith: `${escaped}%`,
        endsWith: `%${escaped}`,
      }[operator];
      conditions.push(`${expression} LIKE ? ${LIKE_ESCAPE_CLAUSE}`);
      parameters.push(pattern);
      return;
    }
    case "isNull":
      conditions.push(
        `${expression} ${readBooleanOperand(operator, operand) ? "IS NULL" : "IS NOT NULL"}`,
      );
      return;
    default:
      return assertNoUncompiledOperator(operator);
  }
}

/**
 * The exhaustiveness backstop for the switch above (F050).
 *
 * An operator lives in two places — `FieldOperators` declares it and
 * `compileOperator` compiles it — and nothing used to check that they agree. The
 * switch returned `void` with no `default`, so a function allowed to fall off
 * its end is one TypeScript has no reason to complain about: an operator added
 * to the interface and forgotten in the switch pushed *no condition*, and a
 * condition that is simply not in the `WHERE` is the fail-open widening the
 * `NO_MATCH` machinery exists to close everywhere else. On the delete path the
 * consequence is total — `deleteMany({ age: { between: [1, 2] } })` would have
 * emptied the table and reported the count truthfully.
 *
 * The `never` parameter is the whole mechanism: a missing case leaves `operator`
 * narrowed to that case's literal type here, which does not assign to `never`,
 * so `mise run typecheck` fails. It throws as well as failing to compile,
 * because `KNOWN_OPERATORS` is a runtime set and a mismatch that arrives through
 * a path `--noEmit` never saw must not fall through silently either.
 */
function assertNoUncompiledOperator(operator: never): never {
  throw new Error(
    `Operator "${String(operator)}" has no case in the query compiler, so it would ` +
      `contribute no condition and silently widen the clause it was written to narrow`,
  );
}

/**
 * The two ways a clause is decided without comparing anything: `0` matches no
 * row, `1` matches every row.
 */
const NO_MATCH = "0";
const MATCH_ALL = "1";

/**
 * A compiled clause, plus the two different questions a caller has to ask about
 * a value that went missing. An empty `OR: []` is a decided "no rows" and is
 * neither: nothing went missing, the caller asked for nothing.
 *
 * They come apart at a disjunction with mixed branches, and the difference is
 * polarity. `OR: [{ assignee: undefined }, { assignee: null }]` is *narrowed* by
 * its missing branch — it returns the unassigned rows, which is the documented
 * work-queue shape and safe to keep. Negate the same clause and the narrowing
 * inverts into a widening: `NOT` of it returns every row the missing condition
 * existed to exclude, and `deleteMany` would take it. So the disjunction is a
 * usable filter (`absent` is false) while still carrying a gap (`containsAbsent`
 * is true), and only the second question may be asked under a negation.
 */
interface CompiledConditions extends CompiledClause {
  /**
   * The clause as a whole decides nothing, so it matches no row. Drives `OR`,
   * where one live alternative is still a filter the caller can stand behind.
   */
  absent: boolean;
  /**
   * A condition somewhere below decided nothing — however deep, and whether or
   * not its siblings rescued the clause it sat in. Drives `NOT`, which must
   * refuse to negate a gap into a match at any depth.
   */
  containsAbsent: boolean;
}

/** Read the branches of an `OR`, which must be a list of nested clauses. */
function readBranches(operand: unknown): Record<string, unknown>[] {
  if (!Array.isArray(operand)) {
    throw new Error(`"${OR_KEY}" expects an array of where-clauses`);
  }
  for (const branch of operand) {
    if (branch === null || typeof branch !== "object" || Array.isArray(branch)) {
      throw new Error(`"${OR_KEY}" expects an array of where-clauses`);
    }
  }
  return operand as Record<string, unknown>[];
}

/**
 * Compile one where-clause into a bare boolean expression — no `WHERE` keyword,
 * so it can be nested inside a combinator. An empty clause compiles to the empty
 * string; every caller decides what "no condition" means in its position.
 */
function compileConditions(where: Record<string, unknown>): CompiledConditions {
  const conditions: string[] = [];
  const parameters: SqlParameter[] = [];
  let absent = false;
  let containsAbsent = false;

  for (const [key, condition] of Object.entries(where)) {
    // The case that bites. A key the caller *supplied* with an `undefined` value
    // used to be skipped, which silently widens the filter it was meant to
    // narrow — and a filter that widens to nothing is a bare `DELETE FROM`. It
    // narrows to nothing instead: the rule an `OR` branch already followed,
    // applied wherever a value goes missing rather than only one level in.
    if (condition === undefined) {
      conditions.push(NO_MATCH);
      absent = true;
      containsAbsent = true;
      continue;
    }

    // The combinators are matched before anything reaches jsonExtract, so a
    // reserved key is never a field path and a field path is never reserved.
    if (key === OR_KEY) {
      const branches = readBranches(condition).map(compileConditions);
      // A combinator fails closed: an empty disjunction matches nothing, as an
      // empty `in` does, and so does a branch that carries no condition of its
      // own.
      if (branches.length === 0) {
        conditions.push(NO_MATCH);
        continue;
      }
      conditions.push(
        `(${branches.map((branch) => (branch.sql === "" ? NO_MATCH : branch.sql)).join(" OR ")})`,
      );
      for (const branch of branches) parameters.push(...branch.parameters);
      // One live alternative is still a filter the caller can stand behind; only
      // a disjunction whose every branch went missing decides nothing.
      if (branches.every((branch) => branch.absent)) absent = true;
      // The gap survives regardless, because negating this disjunction would
      // invert its narrowing into a widening — see `containsAbsent`.
      if (branches.some((branch) => branch.containsAbsent)) containsAbsent = true;
      continue;
    }

    if (key === NOT_KEY) {
      if (condition === null || typeof condition !== "object" || Array.isArray(condition)) {
        throw new Error(`"${NOT_KEY}" expects a single where-clause`);
      }
      const negated = compileConditions(condition as Record<string, unknown>);
      if (negated.containsAbsent) {
        // The one place narrowing a gap to `0` is not enough on its own:
        // `NOT (0)` is every row, so negation would hand back exactly the
        // fail-open this guard exists to close. An absent value stays absent
        // through `NOT` rather than flipping into a match.
        //
        // The test is `containsAbsent`, not `absent`: a disjunction with one
        // live branch is a usable filter but still carries a gap, and negating
        // it turns the branch that narrowed into one that widens. `NOT: { OR:
        // […] }` is the "delete everything except these" retention shape, so
        // the wider complement is exactly what `deleteMany` would act on.
        conditions.push(NO_MATCH);
        absent = true;
        containsAbsent = true;
        continue;
      }
      // Fails closed the same way, by the other route: negating a clause with
      // no conditions — which matches everything — matches nothing.
      conditions.push(`NOT (${negated.sql === "" ? MATCH_ALL : negated.sql})`);
      parameters.push(...negated.parameters);
      continue;
    }

    const expression = jsonExtract(key);

    if (isOperatorObject(condition)) {
      const operatorEntries = Object.entries(condition);
      // An operator object naming no operator is a condition the caller did not
      // supply — the third spelling of the situation the two `undefined`
      // branches already answer, and it gets their answer rather than a third
      // one by accident (F047). `{ age: { ...(bound && { gte: bound }) } }` is
      // the idiomatic optional filter, and it is this shape precisely when the
      // filter is at its widest, which is where widening costs the most.
      if (operatorEntries.length === 0) {
        conditions.push(NO_MATCH);
        absent = true;
        containsAbsent = true;
        continue;
      }
      for (const [operator, operand] of operatorEntries) {
        // The same missing value, one level further in: `{ age: { gte: filter } }`
        // with an unset `filter` must not compile to "every age".
        if (operand === undefined) {
          conditions.push(NO_MATCH);
          absent = true;
          containsAbsent = true;
          continue;
        }
        compileOperator(
          expression,
          operator as keyof FieldOperators<unknown>,
          operand,
          conditions,
          parameters,
        );
      }
    } else if (condition === null) {
      conditions.push(`${expression} IS NULL`);
    } else {
      conditions.push(`${expression} = ?`);
      parameters.push(toSqlParameter(condition, `field "${key}"`));
    }
  }

  if (conditions.length === 0) return { sql: "", parameters: [], absent, containsAbsent };
  return { sql: conditions.join(" AND "), parameters, absent, containsAbsent };
}

/**
 * Compile a typed where-clause into a `WHERE …` SQL fragment plus its bound
 * parameters. Sibling keys are joined with `AND`; the reserved `OR` and `NOT`
 * keys nest.
 *
 * An empty clause — no `where` at all, or `{}` — is the caller asking for no
 * filter, and returns nothing to append. That is the *only* way to reach an
 * unfiltered statement: a `where` that names a key whose value went missing
 * compiles to a clause matching no row, never to a clause that vanishes.
 */
export function compileWhere(where: Record<string, unknown> | undefined): CompiledClause {
  if (where === undefined) return { sql: "", parameters: [] };
  const compiled = compileConditions(where);
  if (compiled.sql === "") return { sql: "", parameters: [] };
  return { sql: `WHERE ${compiled.sql}`, parameters: compiled.parameters };
}

function compileOneOrderBy(orderBy: OrderBy<Record<string, unknown>>): string {
  const direction: SortDirection = orderBy.direction ?? "asc";
  return `${jsonExtract(orderBy.field)} ${direction === "desc" ? "DESC" : "ASC"}`;
}

/** Compile an `orderBy` (single or list) into an `ORDER BY …` SQL fragment. */
export function compileOrderBy(
  orderBy:
    | OrderBy<Record<string, unknown>>
    | OrderBy<Record<string, unknown>>[]
    | undefined,
): string {
  if (orderBy === undefined) return "";
  const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];
  if (clauses.length === 0) return "";
  return `ORDER BY ${clauses.map(compileOneOrderBy).join(", ")}`;
}

/**
 * The `LIMIT` that imposes no bound, for the `OFFSET`-only case: SQLite's
 * grammar has no `OFFSET` without a preceding `LIMIT`, and a negative one is how
 * SQLite itself spells "no limit".
 */
const NO_LIMIT = -1;

/**
 * Read a row bound, which must be a non-negative integer a JavaScript number
 * represents exactly.
 *
 * `Number.isSafeInteger` rather than `Number.isInteger` is the whole point:
 * `Number.isInteger(1e21)` is `true`, so the looser check passed a value that no
 * longer denotes one particular integer — and, while these bounds were still
 * interpolated into the SQL text, `String(1e21)` put the literal `1e+21` there.
 * Neither survives here now: the bound is range-checked *and* bound as a
 * parameter, so the "validated, therefore safe to inline" argument no longer has
 * to hold anything up (F025).
 */
function readRowBound(value: number, role: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Invalid ${role} ${value}: expected a non-negative integer up to ${Number.MAX_SAFE_INTEGER}`,
    );
  }
  return value;
}

/**
 * Compile `LIMIT`/`OFFSET` into a fragment plus its bound parameters.
 *
 * The bounds are **bound, not inlined**. Inlining made every distinct page a
 * distinct SQL string, and `Database.query()` caches a prepared statement per
 * SQL string forever — so a paginating caller retained one statement per page it
 * had ever asked for, unbounded, for the life of the connection (F024). Bound,
 * every page of a query shares one cached statement.
 */
export function compileLimitOffset(
  limit: number | undefined,
  offset: number | undefined,
): CompiledClause {
  const parts: string[] = [];
  const parameters: SqlParameter[] = [];
  if (limit !== undefined) {
    parts.push("LIMIT ?");
    parameters.push(readRowBound(limit, "limit"));
  }
  if (offset !== undefined) {
    if (limit === undefined) {
      parts.push("LIMIT ?");
      parameters.push(NO_LIMIT);
    }
    parts.push("OFFSET ?");
    parameters.push(readRowBound(offset, "offset"));
  }
  return { sql: parts.join(" "), parameters };
}
