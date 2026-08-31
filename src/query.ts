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

const KNOWN_OPERATORS = new Set<keyof FieldOperators<unknown>>([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "notIn",
  "like",
  "contains",
  "startsWith",
  "endsWith",
  "isNull",
]);

/** The reserved `where` keys that combine clauses instead of naming a field. */
const OR_KEY = "OR";
const NOT_KEY = "NOT";

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
  if (value === null || typeof value === "string" || typeof value === "number") {
    return value;
  }
  throw new Error(
    `Unsupported filter value of type ${typeof value}: where-clauses compare scalar fields only`,
  );
}

function isOperatorObject(condition: unknown): condition is FieldOperators<unknown> {
  if (condition === null || typeof condition !== "object" || Array.isArray(condition)) {
    return false;
  }
  const keys = Object.keys(condition);
  return keys.length > 0 && keys.every((key) => KNOWN_OPERATORS.has(key as keyof FieldOperators<unknown>));
}

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
        conditions.push(`${expression} <> ?`);
        parameters.push(toSqlParameter(operand, `operator "${operator}"`));
      }
      return;
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const sqlOperator = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[operator];
      conditions.push(`${expression} ${sqlOperator} ?`);
      parameters.push(toSqlParameter(operand, `operator "${operator}"`));
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
      const placeholders = values.map(() => "?").join(", ");
      const keyword = operator === "in" ? "IN" : "NOT IN";
      conditions.push(`${expression} ${keyword} (${placeholders})`);
      for (const value of values) {
        parameters.push(toSqlParameter(value, `operator "${operator}"`));
      }
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
      conditions.push(`${expression} ${operand ? "IS NULL" : "IS NOT NULL"}`);
      return;
  }
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
      for (const [operator, operand] of Object.entries(condition)) {
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
