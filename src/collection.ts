import type { Database } from "bun:sqlite";
import type { z } from "zod";
import {
  compileLimitOffset,
  compileMembership,
  compileOrderBy,
  compileWhere,
  encodeMembershipList,
  jsonExtract,
  RESERVED_WHERE_KEYS,
} from "./query.ts";
import { isReference } from "./ref.ts";
import {
  type ContainedSchema,
  hasDeclaredDefault,
  MAX_WRAPPER_DEPTH,
  readContainedSchemas,
  readDeclaredFieldNames,
  readObjectShape,
} from "./schema-shape.ts";
import type {
  IndexDefinition,
  IndexInput,
  QueryOptions,
  SqlParameter,
  Where,
} from "./types.ts";

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Rows an unbounded `find()` may return before it throws. */
export const DEFAULT_MAX_ROWS = 10_000;

/**
 * What a read does with a stored row the schema no longer accepts. `"throw"` is
 * the default and the safe one — silently dropping rows is its own hazard.
 * `"skip"` omits the row so an operator can read a damaged collection while
 * repairing it; `validate()` names what is being skipped.
 */
export type ParseErrorPolicy = "throw" | "skip";

/** One stored row that fails the current schema, as reported by `validate()`. */
export interface ValidationFailure {
  /** The row's primary key, which is readable even when its document is not. */
  id: string;
  /** Why it failed — a `ZodError`, or a `SyntaxError` for unparseable JSON. */
  error: unknown;
}

/** Options that configure a collection's identity, indexes, and read policy. */
export interface CollectionOptions {
  /** The document field used as the primary key. Defaults to `"id"`. */
  idField?: string;
  /**
   * Expression indexes to declare on document fields. Indexes are **cumulative
   * across handles**: reopening a collection with a different set adds the new
   * ones and keeps the old, because a reopen with an extended schema is a
   * supported path and its new field may want an index. Only `idField` is
   * pinned on reopen.
   *
   * An index is named after its field list alone, encoded so that no two
   * distinct lists can produce one name (`_` doubles, `.` becomes `_dot_`, and
   * `_and_` separates two fields). Declaring `"a.b"` and `"a_b"` on one table
   * therefore creates two indexes, where up to `0.4.2` they shared a name and
   * the second declaration was a silent no-op. The name is a pure function of the
   * fields, so reopening with the same declaration is still a no-op — that is
   * what makes reopening cheap. An index a version up to 0.4.2 wrote under the
   * old name is adopted on the next open: recreated under the new name and then
   * dropped, so the file carries one index per declaration rather than two.
   *
   * `unique` is deliberately **not** part of the name, so declaring the same
   * fields once non-unique and once unique collides — and that redefinition is
   * **refused loudly**, with a throw naming the `DROP INDEX` that accepts it.
   * Reconciling it silently is not on offer either way round: dropping a UNIQUE
   * index takes away a constraint the application may still believe it has, and
   * adding one can fail against rows already stored. Both are the caller's
   * decision, not this library's.
   */
  indexes?: IndexInput[];
  /**
   * Require every non-identity field of an object schema to declare a
   * `.default(...)`, checked once when the collection is created.
   * Defaults to `true`. Identity fields — the id field and `ref()` foreign keys,
   * including a `ref()` under `.nullable()`, `.optional()` or `.describe()` —
   * are the documented exception.
   *
   * The object is found through the wrappers that keep one underneath
   * (`.transform()`, `.pipe()`, `.brand()`, `.default()`, `z.lazy()`), and a
   * schema that declares no fields at all (`z.string()`, `z.record()`) is
   * skipped. A schema whose fields are *not one readable shape* — a union of
   * object schemas, an intersection — is refused instead of skipped, because
   * skipping it would report a check that never ran; passing `false` here is
   * what accepts it, and it takes the rule off every field of the collection.
   */
  enforceDefaults?: boolean;
  /**
   * What a read does with a row that fails the schema. Defaults to `"throw"`.
   * Either way the offending row's id is named — by the thrown message, or by
   * `validate()`.
   *
   * `"skip"` is a degraded mode with one documented cost: the filter runs
   * *after* SQL has applied `LIMIT`, so a page containing a skipped row comes
   * back short. Reads for repair, not for paging — use `validate()` to find the
   * damage and `"throw"` once it is repaired. `findOne()` is exempt: it streams
   * to the first *readable* match rather than answering `null` past a skipped
   * one, because there `null` would be indistinguishable from "no such
   * document".
   */
  onParseError?: ParseErrorPolicy;
  /**
   * Rows a single `find()` with no explicit `limit` may return before it throws.
   * Defaults to `10_000`; `null` disables the ceiling. Normally set once for
   * every collection via `createStore({ maxRows })` — it is here because
   * `createCollection` is also a direct entry point, and a ceiling that only
   * exists on one of two entry points is not a ceiling.
   */
  maxRows?: number | null;
}

/**
 * The public surface of a single collection — one SQLite table of
 * `(id TEXT PRIMARY KEY, doc TEXT NOT NULL)` rows, gated by a Zod schema on every
 * read and write. `TInput` is the pre-parse input shape (defaults optional);
 * `TDocument` is the post-parse shape every read returns (defaults applied).
 */
export interface Collection<TInput, TDocument> {
  /** The table name backing this collection. */
  readonly name: string;
  /** The document field used as the primary key. */
  readonly idField: string;

  /** Validate and insert one document. Throws if its id already exists. */
  insert(input: TInput): TDocument;
  /** Validate and insert many documents in a single transaction. */
  insertMany(inputs: TInput[]): TDocument[];
  /** Insert or replace one document by id. */
  upsert(input: TInput): TDocument;

  /**
   * Read one document by id, or `null` if absent — or, under
   * `onParseError: "skip"`, if the row no longer matches the schema.
   */
  get(id: string): TDocument | null;
  /**
   * Read many documents by id in one `IN` query. Ids are deduped; the result
   * preserves the order of first appearance and omits ids with no row.
   */
  findByIds(ids: readonly string[]): TDocument[];

  /**
   * Read documents matching a typed query. A query with no `limit` is capped by
   * the collection's `maxRows` and throws rather than truncating when it is
   * exceeded, so an unbounded read is chosen rather than defaulted into.
   */
  find(options?: QueryOptions<TDocument>): TDocument[];
  /**
   * Read the first document matching a typed query, or `null` when there is no
   * match. Under `onParseError: "skip"` that stays true: it streams to the first
   * *readable* match rather than stopping at a skipped one, so `null` never has
   * to be read as "there may be matches further down".
   */
  findOne(options?: QueryOptions<TDocument>): TDocument | null;
  /** Count documents matching an optional where-clause. */
  count(where?: Where<TDocument>): number;

  /**
   * Shallow-merge a patch into an existing document, re-validate, and store it.
   * Returns the updated document, or `null` if the id does not exist. The patch
   * may not change the id field.
   *
   * A key whose value is `undefined` is **not supplied** and leaves the stored
   * value untouched, so building a patch from optional inputs cannot erase a
   * field it never mentioned. That holds for a `ref()` foreign key too: an
   * `undefined` there keeps the stored reference rather than failing the parse.
   * To *clear* a field, name the value you want: `{ note: null }` on a nullable
   * field, or the empty value the schema takes.
   *
   * `replace()` is the wholesale form, where an omitted field does take its
   * schema default — and under `{ enforceDefaults: false }` it is the only way
   * to clear a field that declares no default, because such a field rests at
   * `undefined` and there is no value to name.
   */
  update(id: string, patch: Partial<TInput>): TDocument | null;
  /**
   * Replace an existing document wholesale. Returns the new document, or `null`
   * if the id does not exist. The new document's id must match `id`.
   */
  replace(id: string, input: TInput): TDocument | null;

  /** Delete one document by id. Returns whether a row was removed. */
  delete(id: string): boolean;
  /** Delete every document matching an optional where-clause. Returns the count. */
  deleteMany(where?: Where<TDocument>): number;

  /**
   * Parse every stored row and return the ones that fail, with the id that
   * failed and why. Reads only, throws nothing, and ignores `onParseError` and
   * `maxRows` — it is the repair primitive that turns "the collection is
   * broken" into a list of ids something can act on. Streams the table rather
   * than materialising it, so it is safe on a large collection.
   */
  validate(): ValidationFailure[];
}

function assertIdentifier(value: string, role: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Invalid ${role} "${value}": must be a plain SQL identifier`);
  }
}

/**
 * Field names a where-clause reserves for its combinators (F012). A document
 * that used one as a field would have a field no query could ever address, so
 * the collision is refused where the schema is declared rather than left to
 * surface as a silently mis-compiled filter.
 *
 * The names come from `src/query.ts`, which owns the where-grammar and is the
 * only file entitled to say what a reserved key is; this file used to keep a
 * second literal list of its own, so the guarantee above held only for as long
 * as somebody remembered to edit both (F051). The message renders from the same
 * set for the same reason — prose that names the keys drifts where the list no
 * longer can.
 *
 * The names come from `readDeclaredFieldNames`, so the guard reaches through the
 * wrappers a caller may have put around the object — `.transform()`, `.pipe()`,
 * `.brand()`, `.default()` — rather than seeing no `.shape` and enforcing
 * nothing (F020), and it reads *both* sides of a `.pipe()`, because what a write
 * stores is the output side.
 *
 * It remains a strong default rather than a proof, and the cases left are these:
 * a `.transform()` that *adds or renames* a field declares its output in a
 * function body, which no reader can see into; and a schema whose fields are not
 * one shape at all — a union of object schemas, an intersection — contributes no
 * names, though `assertDefaultsDeclared` refuses those outright, so one only
 * reaches a collection under `{ enforceDefaults: false }`. In both, the field
 * names are the caller's to keep clear of the reserved ones: **do not name a
 * field `OR` or `NOT`.**
 */
function assertNoReservedFieldNames(
  schema: z.ZodType,
  collectionName: string,
  idField: string,
): void {
  for (const fieldName of [...readDeclaredFieldNames(schema), idField]) {
    if (!RESERVED_WHERE_KEYS.has(fieldName)) continue;
    const reservedList = [...RESERVED_WHERE_KEYS].map((key) => `"${key}"`).join(", ");
    throw new Error(
      `Collection "${collectionName}": field "${fieldName}" is a reserved ` +
        `where-clause key. The reserved keys (${reservedList}) combine clauses, ` +
        `so a field of that name could never be filtered on; rename it.`,
    );
  }
}

/**
 * Validate a row ceiling. A positive integer or `null` (disabled); `0` would
 * mean "every unbounded find() throws", which is a mistake rather than an
 * intent, so it is refused at the edge alongside every other bad value.
 */
export function resolveMaxRows(maxRows: number | null | undefined): number | null {
  if (maxRows === undefined) return DEFAULT_MAX_ROWS;
  if (maxRows === null) return null;
  // Bounded below `MAX_SAFE_INTEGER` rather than merely at it, because `find()`
  // compiles the ceiling as `maxRows + 1` and that sum has to stay a safe
  // integer too — otherwise a ceiling accepted here fails later, in the query
  // compiler, which is not the edge this was meant to be refused at.
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows >= Number.MAX_SAFE_INTEGER) {
    throw new Error(
      `Invalid maxRows ${maxRows}: expected a positive integer below ` +
        `${Number.MAX_SAFE_INTEGER}, or null to disable the ceiling`,
    );
  }
  return maxRows;
}

/** The schema name SQLite gives a connection's own database file. */
const MAIN_DATABASE_NAME = "main";

/** What a table was first opened with, and what the caller called it. */
export interface TableBinding {
  idField: string;
  /** The name as first typed, so the throw can name both spellings. */
  openedAs: string;
}

// Hung off the `Database` instance rather than off a store closure, so
// `store.collection()` and a direct `createCollection(database, …)` share one
// registry. Weak so a closed database's bindings are collectable. It is an
// in-process guard only: a second connection to the same file starts with an
// empty registry, which F018 tracks.
//
// A cross-store transaction runs on a connection of its own, so its registry
// starts empty too — which would make this guard structurally unreachable on
// that path rather than merely weakened. `transactionAcross` therefore carries
// each store's bindings onto that connection and back again, through
// `exportTableBindings` / `importTableBindings` below.
const TABLE_BINDINGS = new WeakMap<Database, Map<string, TableBinding>>();

/**
 * The registry key for one table. Case-insensitive, because SQLite identifiers
 * are: `CREATE TABLE IF NOT EXISTS "KS"` resolves to an existing `ks`, so a
 * case-variant name is one table to the database and must be one binding here
 * too. The key carries the database name as well, because a connection inside a
 * cross-store transaction holds several files at once and `main.orders` is not
 * the same table as `store_1.orders`.
 */
function tableBindingKey(databaseName: string, name: string): string {
  return `${databaseName.toLowerCase()}.${name.toLowerCase()}`;
}

/**
 * Refuse a reopen that conflicts with what a table is already open with. Only
 * `idField` is pinned: reopening with an *extended* schema is the supported
 * forward-compatibility path, while identity changing under a table
 * is never intentional — it writes rows under two incompatible conventions and
 * surfaces far away, as a row neither handle can read.
 *
 * Checking is separate from recording so an open can do the two at its two ends:
 * the conflict is refused before the first statement runs, and the binding is
 * recorded only once every statement has succeeded. A call that throws in
 * between leaves no binding behind for the next one to collide with (F045, #8).
 */
function assertTableBinding(
  database: Database,
  databaseName: string,
  name: string,
  idField: string,
): void {
  const existing = TABLE_BINDINGS.get(database)?.get(tableBindingKey(databaseName, name));
  if (existing !== undefined && existing.idField !== idField) {
    // Name both spellings: with a case-variant reopen the caller is looking at
    // a name they believe is new, and "already open" is only actionable if it
    // says what it collides with.
    const openedAs =
      existing.openedAs === name ? `"${name}"` : `"${name}" (same table as "${existing.openedAs}")`;
    throw new Error(
      `collection(${openedAs}): already open with idField "${existing.idField}", ` +
        `cannot reopen with "${idField}". One table holds one identity convention; ` +
        `reopening with an extended schema is supported, changing the id field is not.`,
    );
  }
}

/** Record what a table is open with. The first open of a table wins. */
function recordTableBinding(
  database: Database,
  databaseName: string,
  name: string,
  idField: string,
): void {
  let bindings = TABLE_BINDINGS.get(database);
  if (bindings === undefined) {
    bindings = new Map();
    TABLE_BINDINGS.set(database, bindings);
  }
  const key = tableBindingKey(databaseName, name);
  if (!bindings.has(key)) bindings.set(key, { idField, openedAs: name });
}

/** Check and record in one step, for a caller that runs no statements between. */
function bindTable(
  database: Database,
  databaseName: string,
  name: string,
  idField: string,
): void {
  assertTableBinding(database, databaseName, name, idField);
  recordTableBinding(database, databaseName, name, idField);
}

/**
 * The bindings recorded for one database on a connection. Internal: it exists so
 * a cross-store transaction can move a store's identity conventions onto the
 * connection it runs on — without that the guard would never fire there, because
 * that connection is opened per call and starts with an empty registry.
 */
export function exportTableBindings(
  database: Database,
  databaseName: string,
): TableBinding[] {
  const bindings = TABLE_BINDINGS.get(database);
  if (bindings === undefined) return [];
  const prefix = `${databaseName.toLowerCase()}.`;
  return [...bindings]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, binding]) => binding);
}

/**
 * Adopt bindings taken from another connection, under this connection's name for
 * that database. Refuses a conflict exactly as a reopen does, so carrying them
 * across is the same check rather than a weaker copy of it.
 */
export function importTableBindings(
  database: Database,
  databaseName: string,
  bindings: readonly TableBinding[],
): void {
  for (const binding of bindings) {
    bindTable(database, databaseName, binding.openedAs, binding.idField);
  }
}

function normalizeIndex(index: IndexInput): IndexDefinition {
  if (typeof index === "string") return { fields: [index], unique: false };
  return { fields: index.fields, unique: index.unique ?? false };
}

/**
 * Encode one field path into the identifier charset without losing information:
 * a literal underscore doubles, and a dot becomes `_dot_`. Every underscore in
 * the output therefore opens an escape — `__` for a literal one, `_dot_` for a
 * path separator, `_and_` for the gap between two fields — so the encoding can
 * be read back and no two distinct field lists can produce one string.
 *
 * That injectivity is the whole point (F043, #6). The previous encoding replaced a dot
 * with an underscore, which mapped the distinct paths `a.b` and `a_b` onto one
 * name, and `CREATE INDEX IF NOT EXISTS` keys on the name alone — so the second
 * declaration was a silent no-op, taking a declared `unique` with it.
 */
function encodeIndexPath(fieldPath: string): string {
  return fieldPath.replace(/_/g, "__").replace(/\./g, "_dot_");
}

/**
 * The name an index carries, derived from its field list and nothing else.
 *
 * `unique` is deliberately absent: the flag not being part of the name is what
 * makes a redefinition — the same fields declared once non-unique and once
 * unique — collide here and get refused loudly, rather than quietly becoming two
 * indexes over one expression. The name stays a pure function of the fields, so
 * reopening a collection with the same declaration finds the same index, which
 * is what makes a reopen cheap.
 *
 * Every character comes from a validated source: `tableName` has passed
 * `assertIdentifier` and each field path has passed `jsonExtract`'s path
 * pattern, so the result is `[A-Za-z0-9_]` only and carries nothing a caller
 * chose the shape of — this name is interpolated into SQL text, where an index
 * name cannot be bound.
 */
function indexName(tableName: string, fields: readonly string[]): string {
  return `idx_${tableName}_${fields.map(encodeIndexPath).join("_and_")}`;
}

/**
 * The name this index carried before the encoding above was injective. Written
 * by versions up to 0.4.2, so a file created by one already holds indexes under
 * it: on the next open an index found under this name over the same expression
 * is the same index, and is adopted rather than duplicated.
 *
 * For a single field with neither a dot nor an underscore the two names are
 * equal — the common case, where nothing moves.
 */
function supersededIndexName(tableName: string, fields: readonly string[]): string {
  const suffix = fields.map((field) => field.replace(/\./g, "_")).join("_");
  return `idx_${tableName}_${suffix}`;
}

/** An index already in the database, as far as its stored `CREATE` text says. */
interface ExistingIndex {
  /** The table it is on. An index name is database-wide; an index is not. */
  readonly tableName: string;
  readonly unique: boolean;
  /**
   * The parenthesised expression list it indexes, or `null` for a `CREATE`
   * this library did not write and cannot compare against a declaration.
   */
  readonly expressions: string | null;
}

/**
 * Split a stored `CREATE INDEX` back into the things a declaration is compared
 * against. SQLite keeps the statement text verbatim apart from dropping `IF NOT
 * EXISTS` and the database qualifier, and every index this library writes ends
 * in its expression list, so the comparison is against text this same module
 * generated.
 *
 * That makes `jsonExtract`'s exact output load-bearing across versions: it is
 * what sits in `sqlite_master` in an existing file, and a reopen compares
 * against it. Whitespace is normalised on both sides below so spacing alone
 * cannot turn a reopen into a refusal, but a deeper change to that expression's
 * shape is a change to what every stored index says it is.
 */
const CREATE_INDEX_PATTERN = /^CREATE\s+(UNIQUE\s+)?INDEX\b[\s\S]*?\(([\s\S]*)\)\s*;?\s*$/i;

/** Compare two expression lists as SQL rather than as text. */
function normalizeExpressions(expressions: string): string {
  return expressions.replace(/\s+/g, " ").trim();
}

/**
 * One index declaration, resolved against what the table already carries:
 * validated, named, and reduced to the statements the open has to run.
 */
interface ResolvedIndex {
  readonly name: string;
  readonly fields: readonly string[];
  readonly unique: boolean;
  /** The `json_extract` list, already path-checked. */
  readonly expressions: string;
  /** False when an equivalent index is already on the table. */
  readonly create: boolean;
  /** An equivalent index under the superseded name, to drop once this exists. */
  readonly supersedes: string | null;
}

/**
 * Every index in one database, keyed by name.
 *
 * Read across the whole database rather than one table, because that is the
 * scope an index name lives in: `CREATE INDEX IF NOT EXISTS` on a name another
 * *table* already holds is a silent no-op, which is the same defect F043 (#6)
 * is about one table wider — and a plan drawn from a per-table read would then
 * drop a superseded index whose replacement was never created.
 */
function readExistingIndexes(
  database: Database,
  databaseName: string,
): Map<string, ExistingIndex> {
  // Nothing here reaches the SQL text but the generated database name: this
  // reads the catalogue rather than any table. `sql IS NULL` is an index SQLite
  // made itself (the primary key's), which no declaration can collide with,
  // because a derived name always carries the `idx_` prefix.
  const rows = database
    .query(
      `SELECT name, tbl_name, sql FROM "${databaseName}".sqlite_master ` +
        `WHERE type = 'index' AND sql IS NOT NULL`,
    )
    .all() as Array<{ name: string; tbl_name: string; sql: string }>;
  const existing = new Map<string, ExistingIndex>();
  for (const row of rows) {
    const parsed = CREATE_INDEX_PATTERN.exec(row.sql);
    existing.set(row.name, {
      tableName: row.tbl_name,
      unique: parsed !== null && parsed[1] !== undefined,
      expressions: parsed?.[2] === undefined ? null : normalizeExpressions(parsed[2]),
    });
  }
  return existing;
}

/** SQLite table names are case-insensitive, so two spellings are one table. */
function isSameTable(one: string, other: string): boolean {
  return one.toLowerCase() === other.toLowerCase();
}

function describeUniqueness(unique: boolean): string {
  return unique ? "unique" : "non-unique";
}

/**
 * Refuse a redefinition of an index that is already on the table. This is the
 * deliberate half of F043 (#6): the silent no-op also covered a *genuine* change of
 * mind, and an index is not redefined in place — dropping a UNIQUE takes away a
 * constraint the application may still believe in, and adding one can fail
 * against rows already stored. Both are the caller's call, so the throw names
 * the statement that makes it.
 */
function refuseIndexRedefinition(
  collectionName: string,
  databaseName: string,
  existingName: string,
  existingUnique: boolean,
  fields: readonly string[],
  unique: boolean,
): never {
  throw new Error(
    `collection("${collectionName}"): index "${existingName}" over ` +
      `(${fields.join(", ")}) already exists as a ${describeUniqueness(existingUnique)} ` +
      `index, and this call declares it ${describeUniqueness(unique)}. An index is not ` +
      `redefined in place: dropping a UNIQUE takes a constraint with it, and adding one ` +
      `can fail against rows already stored. Run ` +
      `DROP INDEX "${databaseName}"."${existingName}" and reopen if the change is intended.`,
  );
}

/**
 * Refuse a derived name that another table's index already holds. An index name
 * is database-wide, so this is a real collision: creating under it would be the
 * silent no-op F043 (#6) is about, and the index that answers to the name
 * belongs to somebody else's table.
 */
function refuseForeignIndexName(
  collectionName: string,
  derivedName: string,
  ownerTable: string,
  fields: readonly string[],
): never {
  throw new Error(
    `collection("${collectionName}"): the index name "${derivedName}" derived for ` +
      `(${fields.join(", ")}) is already taken by an index on table "${ownerTable}". ` +
      `An index name is database-wide, so the two cannot both exist: rename that index, ` +
      `or the collection whose name derives onto it, and reopen.`,
  );
}

/**
 * Validate every index declaration and resolve it against the indexes the
 * database already holds. Reads the catalogue, writes nothing and records
 * nothing: every throw a bad or conflicting declaration causes happens here,
 * above the binding and above the first statement of the open (F045, #8).
 */
function resolveIndexes(
  database: Database,
  databaseName: string,
  tableName: string,
  declarations: readonly IndexInput[],
): ResolvedIndex[] {
  if (declarations.length === 0) return [];
  const existing = readExistingIndexes(database, databaseName);
  const resolved = new Map<string, ResolvedIndex>();
  for (const declaration of declarations) {
    const { fields, unique = false } = normalizeIndex(declaration);
    if (fields.length === 0) {
      throw new Error(
        `collection("${tableName}"): an index declaration names no fields. ` +
          `An index is over at least one field path.`,
      );
    }
    // Path-checked first, so the name below is derived from validated paths.
    const expressions = normalizeExpressions(fields.map((field) => jsonExtract(field)).join(", "));
    const name = indexName(tableName, fields);

    const declaredTwice = resolved.get(name);
    if (declaredTwice !== undefined) {
      if (declaredTwice.unique !== unique) {
        throw new Error(
          `collection("${tableName}"): indexes declares (${fields.join(", ")}) twice, ` +
            `once ${describeUniqueness(declaredTwice.unique)} and once ` +
            `${describeUniqueness(unique)}. One field list is one index; declare it once.`,
        );
      }
      continue;
    }

    const current = existing.get(name);
    if (current !== undefined) {
      if (!isSameTable(current.tableName, tableName)) {
        refuseForeignIndexName(tableName, name, current.tableName, fields);
      }
      if (current.expressions !== expressions) {
        throw new Error(
          `collection("${tableName}"): an index named "${name}" already exists on this ` +
            `table over a different expression, so the index declared over ` +
            `(${fields.join(", ")}) cannot be created under the name derived for it. ` +
            `Drop or rename that index and reopen.`,
        );
      }
      if (current.unique !== unique) {
        refuseIndexRedefinition(tableName, databaseName, name, current.unique, fields, unique);
      }
    }

    // An index this declaration wrote under the superseded name is the same
    // index: same expression list, same table. Adopt it — the open creates the
    // one under the injective name and drops that one — rather than leaving the
    // file carrying two indexes over one expression. An index of that name on
    // another table is not this declaration's and is never dropped.
    const supersededName = supersededIndexName(tableName, fields);
    const superseded = supersededName === name ? undefined : existing.get(supersededName);
    const supersedesThis =
      superseded !== undefined &&
      isSameTable(superseded.tableName, tableName) &&
      superseded.expressions === expressions;
    if (supersedesThis && superseded.unique !== unique) {
      refuseIndexRedefinition(
        tableName,
        databaseName,
        supersededName,
        superseded.unique,
        fields,
        unique,
      );
    }

    resolved.set(name, {
      name,
      fields,
      unique,
      expressions,
      // The name is free database-wide when nothing holds it, so the `CREATE`
      // below cannot be a no-op — which is what makes the `DROP` that follows
      // it safe: the replacement is on this table before the superseded one goes.
      create: current === undefined,
      supersedes: supersedesThis ? supersededName : null,
    });
  }
  return [...resolved.values()];
}

/** How many paths or issues an error message names before it stops listing. */
const MAX_REPORTED_PATHS = 10;

/**
 * Name what a value *is* for an error message, never what it holds. The write
 * gate reports paths and types only — an id is document content like any other
 * field (a customer number, a case reference), and an uncaught throw would
 * otherwise put it in a log.
 */
function describeType(value: unknown): string {
  if (value === undefined) return "no value";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (value instanceof Date) return "a Date";
  // A string only reaches this message when it is empty; every other one passes.
  if (typeof value === "string") return "an empty string";
  return `a ${typeof value}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stands in for a path segment whose key is document content, not a field name. */
const ELIDED_KEY = "<key>";

/**
 * Peel the wrappers that leave a field's identity intact — `.default()`,
 * `.optional()`, `.nullable()` — to reach the schema underneath. Reads
 * `innerType` from Zod 4's `_zod.def` or Zod 3's `_def`, since both are peer
 * dependencies here.
 *
 * Only wrappers exposing an `innerType` are followed. `.transform()` and
 * `.pipe()` expose `in`/`out` instead and are deliberately left alone: past one
 * of those, what a value *is* no longer matches what the schema declares, so
 * "undeclared" is the honest answer for the elision below, and eliding is the
 * fail-safe direction. That is the opposite of what the creation guards want,
 * which is why `readObjectShape` in `src/schema-shape.ts` is a separate reader
 * that does follow them — it wants the *declared* shape rather than the honest
 * one. Pointing either at the other's callers would be wrong in both
 * directions (F020).
 *
 * This matters because every non-identity field carries a `.default(...)`, so
 * without peeling, nothing nested would ever read as declared.
 */
function unwrapSchema(schema: unknown): unknown {
  let current = schema;
  // Bounded rather than unbounded: a malformed or self-referencing schema must
  // not spin here, and no real field stacks anywhere near this many wrappers.
  // The bound is the one `src/schema-shape.ts` peels to, imported rather than
  // written out a second time — two literals that have to agree is the shape of
  // F051 in miniature.
  for (let depth = 0; depth < MAX_WRAPPER_DEPTH; depth += 1) {
    const definition =
      (current as { _zod?: { def?: { innerType?: unknown } } } | undefined)?._zod?.def ??
      (current as { _def?: { innerType?: unknown } } | undefined)?._def;
    if (definition?.innerType === undefined) return current;
    current = definition.innerType;
  }
  return current;
}

/**
 * The field shape a schema declares, or `undefined` when it declares none.
 *
 * This is what separates a path segment that is safe to print from one that is
 * not. A `z.object({ ... })` declares its keys: they are field names a developer
 * typed into the schema. A `z.record()` does not — its keys are whatever the
 * caller stored, so under a map keyed by person the key *is* personal data.
 */
function declaredShape(schema: unknown): Record<string, unknown> | undefined {
  const shape = (unwrapSchema(schema) as { shape?: Record<string, unknown> } | undefined)?.shape;
  return typeof shape === "object" && shape !== null ? shape : undefined;
}

/**
 * The field paths at which two parsed documents differ, compared by **type** as
 * well as by value — a `Date` and the string it serialises to are a difference,
 * even though their stored bytes are identical.
 *
 * It reports paths and never values, and a key only counts as part of a path
 * when the schema declares it. Document content is a caller's data, and this
 * library stores it in plaintext, so it must never reach an exception message
 * and from there a log — and a record's keys are document content just as much
 * as its values are.
 *
 * `undefined` and an absent key are one and the same here, because that is what
 * JSON storage makes of them.
 */
function differingPaths(
  written: unknown,
  roundTripped: unknown,
  schema: unknown,
  path = "",
): string[] {
  if (written === roundTripped) return [];
  const here = path === "" ? "(document)" : path;

  if (written instanceof Date || roundTripped instanceof Date) {
    const sameInstant =
      written instanceof Date &&
      roundTripped instanceof Date &&
      written.getTime() === roundTripped.getTime();
    return sameInstant ? [] : [here];
  }
  if (Array.isArray(written) || Array.isArray(roundTripped)) {
    if (
      !Array.isArray(written) ||
      !Array.isArray(roundTripped) ||
      written.length !== roundTripped.length
    ) {
      return [here];
    }
    const elementSchema = (unwrapSchema(schema) as { element?: unknown } | undefined)?.element;
    return written.flatMap((element, index) =>
      differingPaths(element, roundTripped[index], elementSchema, `${path}[${index}]`),
    );
  }
  if (isRecord(written) && isRecord(roundTripped)) {
    const shape = declaredShape(schema);
    const keys = new Set([...Object.keys(written), ...Object.keys(roundTripped)]);
    return [...keys].flatMap((key) => {
      // A declared key is a field name from the schema; anything else is a key
      // the caller's data supplied, so it is elided rather than printed.
      const isDeclared = shape !== undefined && Object.hasOwn(shape, key);
      const segment = isDeclared ? key : ELIDED_KEY;
      return differingPaths(
        written[key],
        roundTripped[key],
        isDeclared ? shape[key] : undefined,
        path === "" ? segment : `${path}.${segment}`,
      );
    });
  }
  return [here];
}

/**
 * Name the differing paths for an error message, capped so it stays readable.
 *
 * Deduplicated, because elided keys collapse: ten drifting entries of one record
 * are all `"map.<key>"`, and repeating that adds no diagnosis while publishing
 * how many keys the document held.
 */
function describePaths(paths: string[]): string {
  const unique = [...new Set(paths)];
  const listed = unique.slice(0, MAX_REPORTED_PATHS).map((path) => `"${path}"`).join(", ");
  const remainder = unique.length - MAX_REPORTED_PATHS;
  const noun = unique.length === 1 ? "field" : "fields";
  return remainder > 0 ? `${noun} ${listed} (+${remainder} more)` : `${noun} ${listed}`;
}

/**
 * The part of a validation issue this library is willing to repeat. Everything
 * else an issue carries is either the rejected value (`received` under Zod 3),
 * the document's own keys (`keys` under `unrecognized_keys`), or a rendered
 * message built from both — so the shape is declared as what is *read* rather
 * than as what Zod exposes, and the rest never has a chance to be printed.
 */
interface ReportableIssue {
  /** The failure's schema vocabulary — `invalid_type`, `invalid_value`, … */
  code?: unknown;
  /** What the schema declared, where the code carries it — `"boolean"`. */
  expected?: unknown;
  /** The field path, whose segments are elided unless the schema declares them. */
  path?: readonly unknown[];
}

/**
 * The issues of a `ZodError`, or `null` for anything that is not one.
 *
 * Recognised by shape rather than by `instanceof`: Zod is a peer dependency, so
 * the error comes from the consumer's copy, and this file imports Zod for types
 * only. The two peer majors agree on `issues` being a non-empty array — which is
 * all this needs to decide whether it has an issue list to render.
 */
function readIssues(error: unknown): ReportableIssue[] | null {
  const issues = (error as { issues?: unknown } | undefined)?.issues;
  return Array.isArray(issues) && issues.length > 0 ? (issues as ReportableIssue[]) : null;
}

/**
 * Render one issue's path under the same rule `differingPaths` applies: a
 * segment is printable when the schema declares it, and `<key>` otherwise.
 *
 * The schema is walked alongside the path so each segment is judged against the
 * shape that actually holds it — a `z.object()` declares its keys and they are
 * field names a developer typed, a `z.record()` does not and its keys are the
 * caller's data. Anything the walk cannot follow (a union, a `.transform()`)
 * leaves the schema `undefined`, which reads as undeclared and elides — the
 * fail-safe direction.
 */
function describeIssuePath(segments: readonly unknown[], schema: unknown): string {
  let current = schema;
  let path = "";
  for (const segment of segments) {
    if (typeof segment === "number") {
      // An array index names a position, not content — as differingPaths prints it.
      path = `${path}[${segment}]`;
      current = (unwrapSchema(current) as { element?: unknown } | undefined)?.element;
      continue;
    }
    // A non-string segment names nothing a schema can declare, so it never
    // reaches a shape lookup and elides like an undeclared key.
    const shape = typeof segment === "string" ? declaredShape(current) : undefined;
    const isDeclared = shape !== undefined && Object.hasOwn(shape, segment as string);
    const rendered = isDeclared ? (segment as string) : ELIDED_KEY;
    path = path === "" ? rendered : `${path}.${rendered}`;
    current = isDeclared ? shape[segment as string] : undefined;
  }
  return path === "" ? "(document)" : path;
}

/**
 * Describe the issues of a `ZodError` in terms that are safe to put in a
 * message: the path, the `code`, and `expected` where the code carries one.
 *
 * A `ZodError`'s own `message` is the serialised issue list, and that list is
 * document content — an issue's `path` runs through a `z.record()`'s keys on
 * both peer majors, and under Zod 3 the issue carries the rejected value as
 * `received`. So the list is rendered here rather than forwarded, on the same
 * terms the write gate has always held itself to (F028).
 *
 * `expected` is only printed when it is a string, which is what the type codes
 * put there; a code whose `expected` is a declared literal of some other type
 * prints its code alone rather than reaching into the schema's values.
 *
 * Deduplicated and capped like `describePaths`, and for the same reason: elided
 * keys collapse, so ten rejected entries of one record are all
 * `"map.<key>"` and repeating that publishes how many keys the document held.
 */
function describeIssues(issues: readonly ReportableIssue[], schema: unknown): string {
  const rendered = issues.map((issue) => {
    const path = describeIssuePath(Array.isArray(issue.path) ? issue.path : [], schema);
    const code = typeof issue.code === "string" ? issue.code : "invalid";
    const expected = typeof issue.expected === "string" ? `, expected ${issue.expected}` : "";
    return `"${path}" (${code}${expected})`;
  });
  const unique = [...new Set(rendered)];
  const listed = unique.slice(0, MAX_REPORTED_PATHS).join(", ");
  const remainder = unique.length - MAX_REPORTED_PATHS;
  const noun = unique.length === 1 ? "issue" : "issues";
  return remainder > 0 ? `${noun} ${listed} (+${remainder} more)` : `${noun} ${listed}`;
}

/**
 * How many levels of nesting the declared-default walk descends before it
 * refuses. The walk already terminates on a schema that reaches itself — a shape
 * it has walked is not walked again — but `z.lazy()` may hand back a *fresh*
 * schema on every call, which no identity check can catch. Past this bound the
 * rule is refused rather than skipped, for the same reason an unreadable shape
 * is: enforcing nothing is a rule reporting a check it never ran. No document a
 * person writes nests anywhere near this deep.
 */
const MAX_NESTING_DEPTH = 10;

/** What one descent of the declared-default walk carries with it. */
interface DefaultsWalk {
  readonly collectionName: string;
  readonly idField: string;
  /**
   * Shapes already walked, so a self-referential schema terminates. It is a memo
   * as much as a cycle guard: a shape's members answer the same way wherever the
   * shape is reached from. The **collection's own** shape is deliberately not
   * recorded, because it is the one shape walked under the `idField` exemption —
   * a self-referential document is therefore walked once more, one level in,
   * where a member named like the id field is held to the rule like any other.
   */
  readonly walkedShapes: Set<object>;
}

/** How a contained member extends the path of the container that holds it. */
function containedPath(path: string, contained: ContainedSchema): string {
  if (contained.kind === "value") return path === "" ? ELIDED_KEY : `${path}.${ELIDED_KEY}`;
  if (contained.kind === "item") return `${path}[${contained.position}]`;
  return `${path}[]`;
}

/**
 * Enforce the default rule at collection creation: every non-identity field of
 * an object schema declares a default, so old rows read forward under an extended
 * schema and no field is silently dropped from storage. This library is the
 * only place that sees every schema that reaches storage, so it is the place
 * the rule is checked rather than merely documented.
 *
 * The fields come from `readObjectShape`, which follows the wrappers that keep
 * an object underneath, so a `.transform()` on the schema no longer switches the
 * rule off without saying so (F020).
 *
 * A schema whose fields are not one readable shape — a union of object schemas,
 * an intersection — is **refused** rather than skipped. That is the deliberate
 * half of F020: the two answers "this declares no fields" and "this declares
 * fields I cannot read" used to be one, and enforcing nothing on the second is a
 * rule that reports a check it never performed. `{ enforceDefaults: false }` is
 * the way past it, which makes the exception a caller's decision rather than an
 * accident of how the schema was spelled.
 *
 * The walk **recurses** (F048, #11). It used to read one shape and stop, so a
 * member nested inside a defaulted object was never asked for a default of its
 * own — and a parent's `.default(…)` does not cover it: a stored row that
 * already holds the object is parsed against every member of it, so adding one
 * defaultless member made every row written before the extension unreadable,
 * loudly, on the first read of an old row rather than here. Where the recursion
 * goes, and where it stops, is `assertSchemaDefaults` below.
 */
function assertDefaultsDeclared(
  schema: z.ZodType,
  collectionName: string,
  idField: string,
): void {
  assertSchemaDefaults(schema, "", { collectionName, idField, walkedShapes: new Set() }, 0);
}

/**
 * One step of the declared-default walk: hold every member a schema declares to
 * the rule, then descend into whatever those members declare in turn. `path` is
 * the dotted field path this schema sits at, and `""` is the collection's own
 * schema.
 *
 * **Where it descends.** Into every declared field, and into every value a
 * schema stores *without* a declared field name — an array's elements, a tuple's
 * positions and its `rest` tail, a record's values, an object's `.catchall()`
 * keys — because each of those is a schema an *already-stored* value is parsed
 * against, which is the whole of what the rule is about. The wrappers around
 * either are followed by the readers in `schema-shape.ts`, so `.default()`,
 * `.transform()` and `z.lazy()` do not hide a shape from the walk.
 *
 * **What is exempt.** `isReference` at any depth: a foreign key is
 * identity-shaped wherever it sits. `idField` **only at the top level**, because
 * it names the column this collection keys its rows by — a nested member that
 * happens to share the name is an ordinary field and is held to the rule.
 *
 * **Where it stops.** At a shape it has already walked, which terminates a
 * self-referential schema; at `MAX_NESTING_DEPTH`, which terminates a `z.lazy()`
 * that builds a new schema per call; at a shape it cannot read as one shape (a
 * union, an intersection), which it refuses rather than skips, exactly as it
 * does for the collection's own schema; and at `z.map()` / `z.set()`, which are
 * skipped on purpose because neither survives the write gate's JSON round-trip,
 * so no such field ever reaches storage to be read forward.
 */
function assertSchemaDefaults(
  schema: unknown,
  path: string,
  walk: DefaultsWalk,
  depth: number,
): void {
  if (depth > MAX_NESTING_DEPTH) {
    throw new Error(
      `Collection "${walk.collectionName}": field "${path}" nests more than ` +
        `${MAX_NESTING_DEPTH} levels deep, so the declared-default rule cannot be ` +
        `enforced past it. Flatten the schema, or pass { enforceDefaults: false } to ` +
        `take the schema's fields on yourself.`,
    );
  }

  const reading = readObjectShape(schema);
  if (reading.kind === "opaque") {
    throw new Error(
      path === ""
        ? `Collection "${walk.collectionName}": the schema's fields cannot be read as one ` +
          `shape, so the declared-default rule cannot be enforced on it — a union or an ` +
          `intersection of object schemas declares fields, but not as one shape. Give the ` +
          `collection a single object schema (the wrappers around one — .transform(), ` +
          `.pipe(), .brand(), .default() — are followed), or pass ` +
          `{ enforceDefaults: false } to take the schema's fields on yourself.`
        : `Collection "${walk.collectionName}": field "${path}" declares fields that cannot ` +
          `be read as one shape, so the declared-default rule cannot be enforced on them — ` +
          `a union or an intersection of object schemas declares fields, but not as one ` +
          `shape. Give the field a single object schema (the wrappers around one — ` +
          `.transform(), .pipe(), .brand(), .default() — are followed), or pass ` +
          `{ enforceDefaults: false } to take the schema's fields on yourself.`,
    );
  }

  if (reading.kind === "declared") {
    // The memo covers this shape's containers as well as its fields: a
    // `.catchall()` belongs to the shape that declares it, and was walked with
    // it, so a shape reached twice stops here rather than descending again.
    if (walk.walkedShapes.has(reading.shape)) return;
    if (path !== "") walk.walkedShapes.add(reading.shape);
    assertDeclaredFieldDefaults(reading.shape, path, walk, depth);
  }

  // A schema also stores values a declared field name never reaches — an array's
  // elements, a tuple's positions and `rest` tail, a record's values, an
  // object's `.catchall()` keys — and each of those is parsed against a schema
  // exactly as a stored field is. An object is both at once, which is why this
  // runs for a declared shape as well as for one that declares no fields.
  for (const contained of readContainedSchemas(schema)) {
    assertSchemaDefaults(contained.schema, containedPath(path, contained), walk, depth + 1);
  }
}

/**
 * Hold every field one shape declares to the rule, and descend into each. Split
 * out so the container descent in `assertSchemaDefaults` reads as the separate
 * question it is: a `.catchall()` object answers both.
 */
function assertDeclaredFieldDefaults(
  shape: Record<string, z.ZodType>,
  path: string,
  walk: DefaultsWalk,
  depth: number,
): void {
  for (const [fieldName, fieldSchema] of Object.entries(shape)) {
    if (path === "" && fieldName === walk.idField) continue;
    if (isReference(fieldSchema)) continue;
    const fieldPath = path === "" ? fieldName : `${path}.${fieldName}`;
    if (!hasDeclaredDefault(fieldSchema)) {
      throw new Error(
        `Collection "${walk.collectionName}": field "${fieldPath}" has no default. Every ` +
          `non-identity field must declare .default(...) so old rows read forward under ` +
          `an extended schema, or the field is dropped from storage entirely. A default on ` +
          `an enclosing object does not cover its members: a row that already stores the ` +
          `object is parsed against every one of them. Identity ` +
          `fields are the documented exception — the id field, and a ref() foreign key ` +
          `whether or not it is wrapped in .nullable(), .optional() or .describe(); pass ` +
          `{ enforceDefaults: false } to opt out.`,
      );
    }
    assertSchemaDefaults(fieldSchema, fieldPath, walk, depth + 1);
  }
}

/**
 * Create a collection bound to a `bun:sqlite` database. Creates the backing
 * table and any declared expression indexes if they do not already exist.
 */
export function createCollection<TSchema extends z.ZodType>(
  database: Database,
  name: string,
  schema: TSchema,
  options: CollectionOptions = {},
): Collection<z.input<TSchema>, z.output<TSchema>> {
  return createQualifiedCollection(database, MAIN_DATABASE_NAME, name, schema, options);
}

/**
 * Create a collection over a named database on a connection — `main` for the
 * connection's own file, an attached schema name for a file a cross-store
 * transaction brought along. Every statement this collection emits is
 * schema-qualified, so two collections of the same name on two attached files
 * address their own tables.
 *
 * Not part of the public surface: `createCollection` is the entry point for a
 * plain connection, and `transactionAcross` is the only caller that has an
 * attached schema to name.
 */
export function createQualifiedCollection<TSchema extends z.ZodType>(
  database: Database,
  databaseName: string,
  name: string,
  schema: TSchema,
  options: CollectionOptions = {},
): Collection<z.input<TSchema>, z.output<TSchema>> {
  // Resolving the options is the whole validation phase, and it is a separate
  // call so the ordering holds structurally rather than by line order (F045,
  // #8): the body below never sees `options`, so an option added later is
  // unreachable until it is resolved here — above the binding, above the first
  // statement.
  return openResolvedCollection(
    database,
    databaseName,
    name,
    schema,
    resolveCollectionOptions(database, databaseName, name, schema, options),
  );
}

/** Every option of a collection, validated and reduced to what the open runs on. */
interface ResolvedCollectionOptions {
  readonly idField: string;
  readonly maxRows: number | null;
  readonly onParseError: ParseErrorPolicy;
  readonly indexes: readonly ResolvedIndex[];
}

/**
 * Validate every option and resolve it to the form the collection is opened
 * with. This function records no process state and emits no statement: it reads
 * the catalogue and it throws, and nothing else. That is what makes the
 * invariant `openResolvedCollection` states true — a call that fails on any
 * option, `indexes` included, leaves no binding, no table and no index behind.
 */
function resolveCollectionOptions(
  database: Database,
  databaseName: string,
  name: string,
  schema: z.ZodType,
  options: CollectionOptions,
): ResolvedCollectionOptions {
  // The database name is generated (`main`, `store_1`, …) rather than supplied,
  // but it is interpolated into every statement of the open, so it is held to
  // the same identifier rule as everything else that reaches the SQL text.
  assertIdentifier(databaseName, "database name");
  assertIdentifier(name, "collection name");
  const idField = options.idField ?? "id";
  assertIdentifier(idField, "id field");
  assertNoReservedFieldNames(schema, name, idField);
  if (options.enforceDefaults ?? true) assertDefaultsDeclared(schema, name, idField);
  return {
    idField,
    maxRows: resolveMaxRows(options.maxRows),
    onParseError: options.onParseError ?? "throw",
    indexes: resolveIndexes(database, databaseName, name, options.indexes ?? []),
  };
}

function openResolvedCollection<TSchema extends z.ZodType>(
  database: Database,
  databaseName: string,
  name: string,
  schema: TSchema,
  resolvedOptions: ResolvedCollectionOptions,
): Collection<z.input<TSchema>, z.output<TSchema>> {
  type TInput = z.input<TSchema>;
  type TDocument = z.output<TSchema>;

  const { idField, maxRows, onParseError } = resolvedOptions;
  // Every option is validated before the first statement runs, in
  // `resolveCollectionOptions` upstream of this function — so a bad one never
  // leaves a table behind — and the reopen conflict is refused here, before the
  // open can add an index or a row under the wrong identity convention.
  assertTableBinding(database, databaseName, name, idField);

  const quotedTable = `"${databaseName}"."${name}"`;

  database.run(
    `CREATE TABLE IF NOT EXISTS ${quotedTable} (id TEXT PRIMARY KEY, doc TEXT NOT NULL)`,
  );

  for (const index of resolvedOptions.indexes) {
    if (index.create) {
      const uniqueKeyword = index.unique ? "UNIQUE " : "";
      // SQLite qualifies an index by its *own* name — `CREATE INDEX db.idx ON
      // table` — and resolves the table in that same database; a qualified table
      // name here is a syntax error rather than the obvious spelling.
      database.run(
        `CREATE ${uniqueKeyword}INDEX IF NOT EXISTS "${databaseName}"."${index.name}" ON "${name}" (${index.expressions})`,
      );
    }
    // Dropped only after the replacement exists: a process that dies between the
    // two leaves a duplicate index the next open clears, where the other order
    // would leave the table with neither — and, for a UNIQUE one, with no
    // constraint.
    if (index.supersedes !== null) {
      database.run(`DROP INDEX IF EXISTS "${databaseName}"."${index.supersedes}"`);
    }
  }

  // Recorded last, once every statement of this open has succeeded. A call that
  // threw — on an option above, or on a statement here, as `CREATE UNIQUE INDEX`
  // does against stored duplicates — leaves no binding for the next call to
  // collide with, which is the whole of F045 (#8): the table is open under this
  // identity convention, or it was never opened at all.
  recordTableBinding(database, databaseName, name, idField);

  // Cached statements — bun:sqlite reuses the underlying prepared statement.
  const insertStatement = database.query(
    `INSERT INTO ${quotedTable} (id, doc) VALUES (?, ?)`,
  );
  const upsertStatement = database.query(
    `INSERT OR REPLACE INTO ${quotedTable} (id, doc) VALUES (?, ?)`,
  );
  const getStatement = database.query(`SELECT doc FROM ${quotedTable} WHERE id = ?`);
  // One statement for every batch size (F027). The ids bind as a single JSON
  // array rather than one placeholder each, so this SQL no longer varies with
  // how many ids a caller passes — which is what let a caller-chosen batch size
  // mint an uncollected prepared statement per distinct size. It can be
  // prepared here, once, precisely because there is only one of it now.
  const findByIdsStatement = database.query(
    `SELECT id, doc FROM ${quotedTable} WHERE ${compileMembership("id", "IN")}`,
  );
  const updateStatement = database.query(
    `UPDATE ${quotedTable} SET doc = ? WHERE id = ?`,
  );
  const deleteStatement = database.query(`DELETE FROM ${quotedTable} WHERE id = ?`);

  function readId(document: Record<string, unknown>): string {
    const value = document[idField];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `Collection "${name}": document is missing a string id field "${idField}" ` +
          `(got ${describeType(value)}). Field names and types only — no document ` +
          `values are included in this message.`,
      );
    }
    return value;
  }

  /**
   * Parse one stored row without deciding what to do about a failure. Malformed
   * JSON is a failure like any other: both leave a row that cannot be returned,
   * and both are the caller's to see rather than the read path's to hide.
   */
  function parseStored(text: string): { ok: true; document: TDocument } | { ok: false; error: unknown } {
    try {
      const parsed = schema.safeParse(JSON.parse(text));
      if (parsed.success) return { ok: true, document: parsed.data as TDocument };
      return { ok: false, error: parsed.error };
    } catch (error) {
      return { ok: false, error };
    }
  }

  /**
   * Describe a read failure in terms that are safe to put in a message.
   *
   * A `SyntaxError` from `JSON.parse` is not one: JavaScriptCore quotes the
   * token it choked on, so a row corrupted to hold a bare identifier reproduced
   * that fragment of the stored document into the exception and from there into
   * a log — the one leak the write gate was hardened to prevent, one surface
   * along (F021). The position is the part of that error that actually
   * diagnoses anything and it is a pair of numbers, so the position is kept and
   * the text is dropped.
   *
   * A `ZodError` is not one either, and for the same reason (F028). Its
   * `message` is the serialised issue list: an issue's `path` contains a
   * `z.record()`'s keys — which `differingPaths` elides as `<key>` a couple of
   * hundred lines above, for exactly this reason — and under Zod 3 the issue
   * carries the rejected value as `received`. So the issue list is rendered
   * through `describeIssues`, which prints the path, the `code` and `expected`
   * and drops everything else. An earlier revision of this comment asserted that
   * a `ZodError` "names paths and types, carrying no values"; it does not, and
   * this is what makes that true instead of merely claimed.
   *
   * The original error stays as the `cause` either way: a caller that
   * deliberately inspects it is a different decision from a message that lands
   * in a log by default.
   */
  function describeReadFailure(error: unknown): string {
    if (error instanceof SyntaxError) {
      const { line, column } = error as SyntaxError & { line?: unknown; column?: unknown };
      const position =
        typeof line === "number" && typeof column === "number"
          ? ` at line ${line}, column ${column}`
          : "";
      return (
        `Malformed JSON${position} — the parser's own message is withheld because ` +
        `it quotes the token it failed on, which is document content.`
      );
    }
    const issues = readIssues(error);
    if (issues !== null) {
      return (
        `Rejected at ${describeIssues(issues, schema)} — the validator's own ` +
        `message is withheld because it quotes the rejected value and the keys of ` +
        `any record on the path. (Paths and codes only; the error itself is the cause.)`
      );
    }
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * The error every path throws for a row it cannot read. A `ZodError` — or a
   * bare `SyntaxError` from `JSON.parse` — does not say *which* row failed,
   * which is what makes diagnosis expensive; the id goes in the message and the
   * original error is kept as the `cause`. `hint` differs because the way out
   * differs: a read can be told to skip the row, a write never can.
   */
  function unreadableRow(id: string, error: unknown, hint: string): Error {
    const detail = describeReadFailure(error);
    return new Error(
      `Collection "${name}": stored row "${id}" does not match the current schema. ` +
        `${hint} ${detail}`,
      { cause: error },
    );
  }

  /**
   * Apply the read policy to one row: the parsed document, or `null` when
   * `"skip"` drops it.
   */
  function readRow(id: string, text: string): TDocument | null {
    const outcome = parseStored(text);
    if (outcome.ok) return outcome.document;
    if (onParseError === "skip") return null;
    throw unreadableRow(
      id,
      outcome.error,
      `Call validate() to list every failing row, or open the collection with ` +
        `{ onParseError: "skip" } to read past it while repairing.`,
    );
  }

  /**
   * Read the stored JSON of a row a write is about to modify. Only the JSON has
   * to be well-formed — a row that parses but no longer satisfies the schema is
   * exactly what `update` repairs, so it must not be refused here. A row whose
   * JSON is malformed cannot be merged into at all, and a write never skips:
   * it throws whatever `onParseError` says, with the same named message a read
   * would have given.
   */
  function readStoredJson(id: string, text: string): Record<string, unknown> {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch (error) {
      throw unreadableRow(
        id,
        error,
        `Its stored JSON is malformed, so there is nothing to merge a patch into. ` +
          `Call validate() to list every failing row; a write never skips one.`,
      );
    }
  }

  /** Apply the read policy across a batch, dropping whatever `"skip"` skips. */
  function readRows(rows: Array<{ id: string; doc: string }>): TDocument[] {
    const documents: TDocument[] = [];
    for (const row of rows) {
      const document = readRow(row.id, row.doc);
      if (document !== null) documents.push(document);
    }
    return documents;
  }

  /**
   * Serialise a parsed document for storage, refusing anything the collection
   * could not read back as it was written. Reads re-parse the stored JSON, so a
   * document is only storable if its stored form both *passes* the schema and
   * *parses back to itself*: a `z.date()` fails the first (its stored form is a
   * string the schema rejects — that is what `dateParser` exists for), and a
   * value-changing `.transform()` fails the second (every read would return a
   * different value, and every update would compound it).
   *
   * "Back to itself" is compared by type and value, not by serialized bytes: a
   * `Date` under an unstructured field (`z.record(…, z.unknown())`, a union with
   * a string branch) serialises to a string the schema accepts and then reads
   * back as a `String`. Identical bytes, different value — refused.
   *
   * The cost is one extra parse per write, paid to turn a permanent silent
   * corruption into a loud error at the call site that caused it.
   */
  function serializeDocument(parsed: Record<string, unknown>): string {
    const serialized = JSON.stringify(parsed);
    const roundTripped = schema.safeParse(JSON.parse(serialized));
    if (!roundTripped.success) {
      // The issue list is rendered rather than forwarded, on the same terms the
      // throw below has always held itself to: a ZodError's message quotes the
      // rejected value and any record key on the path (F028).
      const issues = readIssues(roundTripped.error);
      const detail =
        issues === null
          ? "The validator reported no issues."
          : `Rejected at ${describeIssues(issues, schema)}.`;
      throw new Error(
        `Collection "${name}": document does not survive a JSON round-trip — a ` +
          `field's stored form is rejected by its own schema. Use dateParser for ` +
          `dates. ${detail} (Paths and codes only — no document values are ` +
          `included in this message.)`,
      );
    }
    const drifted = differingPaths(parsed, roundTripped.data, schema);
    if (drifted.length > 0) {
      throw new Error(
        `Collection "${name}": document is not stable across a JSON round-trip — ` +
          `the stored form of ${describePaths(drifted)} does not read back as what ` +
          `was written, so every read would return a different value. A schema that ` +
          `reaches storage must be parse-idempotent: remove the .transform() (or ` +
          `coercion) that rewrites an already-parsed value, and use dateParser for a ` +
          `date the schema does not type as one. (Paths only — no document values are ` +
          `included in this message.)`,
      );
    }
    return serialized;
  }

  function insert(input: TInput): TDocument {
    const parsed = schema.parse(input) as Record<string, unknown>;
    insertStatement.run(readId(parsed), serializeDocument(parsed));
    return parsed as TDocument;
  }

  const runInsertMany = database.transaction((inputs: TInput[]) => inputs.map(insert));

  function upsert(input: TInput): TDocument {
    const parsed = schema.parse(input) as Record<string, unknown>;
    upsertStatement.run(readId(parsed), serializeDocument(parsed));
    return parsed as TDocument;
  }

  function get(id: string): TDocument | null {
    const row = getStatement.get(id) as { doc: string } | null;
    return row === null ? null : readRow(id, row.doc);
  }

  function findByIds(ids: readonly string[]): TDocument[] {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return [];
    const rows = findByIdsStatement.all(
      encodeMembershipList(uniqueIds, `findByIds on collection "${name}"`),
    ) as Array<{ id: string; doc: string }>;
    const byId = new Map<string, TDocument>();
    for (const row of rows) {
      const document = readRow(row.id, row.doc);
      if (document !== null) byId.set(row.id, document);
    }
    const found: TDocument[] = [];
    for (const id of uniqueIds) {
      const document = byId.get(id);
      if (document !== undefined) found.push(document);
    }
    return found;
  }

  /**
   * Compile the `SELECT` a find-shaped query runs. `limit` is passed rather than
   * read off the options because the row ceiling and the streaming `findOne`
   * each need their own bound over the same where/order/offset.
   */
  function compileFind(
    queryOptions: QueryOptions<TDocument>,
    limit: number | undefined,
  ): { sql: string; parameters: SqlParameter[] } {
    const whereClause = compileWhere(queryOptions.where as Record<string, unknown> | undefined);
    const orderClause = compileOrderBy(
      queryOptions.orderBy as
        | Parameters<typeof compileOrderBy>[0],
    );
    const pageClause = compileLimitOffset(limit, queryOptions.offset);
    const sql = [`SELECT id, doc FROM ${quotedTable}`, whereClause.sql, orderClause, pageClause.sql]
      .filter((part) => part.length > 0)
      .join(" ");
    // Parameters bind by position, so they concatenate in the order their
    // fragments appear in the statement: WHERE, then the page bounds.
    return { sql, parameters: [...whereClause.parameters, ...pageClause.parameters] };
  }

  /**
   * Stream a query's rows without materialising them, over a statement of this
   * call's own. `database.query()` caches by SQL text, and a cached statement
   * left mid-scan by an early exit *resumes* from there on its next use — the
   * next caller silently gets the tail of someone else's scan. A statement
   * prepared here and finalized in `finally` cannot carry that state out, and
   * two overlapping scans of the same SQL stay independent. The `finally` also
   * covers an early `return` from the consumer, because `for…of` closes the
   * generator on its way out.
   */
  function* streamRows(
    sql: string,
    parameters: SqlParameter[],
  ): Generator<{ id: string; doc: string }> {
    const statement = database.prepare(sql);
    try {
      yield* statement.iterate(...parameters) as Iterable<{ id: string; doc: string }>;
    } finally {
      statement.finalize();
    }
  }

  function find(queryOptions: QueryOptions<TDocument> = {}): TDocument[] {
    // A query the caller bounded is theirs to bound. An unbounded one is capped
    // at maxRows + 1, so the extra row is the evidence that the ceiling was
    // exceeded rather than merely reached.
    const ceiling = queryOptions.limit === undefined ? maxRows : null;
    const limit = ceiling === null ? queryOptions.limit : ceiling + 1;
    const { sql, parameters } = compileFind(queryOptions, limit);
    const rows = database.query(sql).all(...parameters) as Array<{
      id: string;
      doc: string;
    }>;
    // Throwing beats truncating: a silently truncated result is a wrong answer,
    // while a throw names the collection and says what to do about it.
    if (ceiling !== null && rows.length > ceiling) {
      throw new Error(
        `find() on "${name}" returned more than maxRows (${ceiling}). Pass an explicit ` +
          `limit, paginate, or raise/disable maxRows on the store.`,
      );
    }
    return readRows(rows);
  }

  function findOne(queryOptions: QueryOptions<TDocument> = {}): TDocument | null {
    if (onParseError === "throw") {
      const results = find({ ...queryOptions, limit: 1 });
      return results.length > 0 ? (results[0] as TDocument) : null;
    }
    // Under "skip", `LIMIT 1` asks SQL for the first *stored* match and the skip
    // filter can then drop it — returning null while readable matches sit right
    // behind it, which is indistinguishable from "no such document" for exactly
    // the operator repairing a damaged collection. Stream in query order instead
    // and stop at the first row that parses: at most one document is ever held,
    // so no ceiling is needed, and a healthy collection still stops at row one.
    const { sql, parameters } = compileFind(queryOptions, undefined);
    for (const row of streamRows(sql, parameters)) {
      const document = readRow(row.id, row.doc);
      if (document !== null) return document;
    }
    return null;
  }

  function count(where?: Where<TDocument>): number {
    const whereClause = compileWhere(where as Record<string, unknown> | undefined);
    const sql = [`SELECT count(*) AS count FROM ${quotedTable}`, whereClause.sql]
      .filter((part) => part.length > 0)
      .join(" ");
    const row = database.query(sql).get(...whereClause.parameters) as { count: number };
    return row.count;
  }

  // A read-modify-write is only correct while it holds the write lock: without
  // one, a second connection can commit between the SELECT and the UPDATE and
  // have its change silently overwritten. `.immediate` takes the write lock up
  // front (BEGIN IMMEDIATE) rather than on first write, so the race cannot be
  // lost during a lock upgrade either; a contending writer waits out its
  // busy_timeout and then fails loudly instead of disappearing.
  const runUpdate = database.transaction(
    (id: string, patch: Partial<TInput>): TDocument | null => {
      const row = getStatement.get(id) as { doc: string } | null;
      if (row === null) return null;
      // A patch key holding `undefined` is "not supplied", not "assign nothing".
      // Spread it in and `JSON.stringify` drops the key, the field's `.default(...)`
      // refills it on the next parse, and the stored value is gone — silently, and
      // on the most ordinary call there is: `update(id, { title: form.title })`
      // with an optional `form.title`. Dropped keys leave the stored value alone;
      // clearing a field means naming the value you want it cleared to.
      const supplied = Object.fromEntries(
        Object.entries(patch as Record<string, unknown>).filter(
          ([, value]) => value !== undefined,
        ),
      );
      // The patch merges into the *stored* document, not into the parsed output
      // of a read: parsed output is `z.output`, feeding it back as `z.input`
      // re-applies every transform the schema carries.
      const merged = { ...readStoredJson(id, row.doc), ...supplied };
      const parsed = schema.parse(merged) as Record<string, unknown>;
      if (readId(parsed) !== id) {
        throw new Error(`update("${id}"): a patch must not change the id field "${idField}"`);
      }
      updateStatement.run(serializeDocument(parsed), id);
      return parsed as TDocument;
    },
  ).immediate;

  const runReplace = database.transaction((id: string, input: TInput): TDocument | null => {
    const parsed = schema.parse(input) as Record<string, unknown>;
    if (readId(parsed) !== id) {
      throw new Error(`replace("${id}"): the replacement's id field "${idField}" must equal "${id}"`);
    }
    const result = updateStatement.run(serializeDocument(parsed), id);
    return result.changes === 0 ? null : (parsed as TDocument);
  }).immediate;

  function deleteById(id: string): boolean {
    return deleteStatement.run(id).changes > 0;
  }

  function validate(): ValidationFailure[] {
    const failures: ValidationFailure[] = [];
    // Streamed, not materialised: this is the method reached for when a
    // collection is already in trouble, and it must not add an out-of-memory to
    // the problem it was called to diagnose.
    for (const row of streamRows(`SELECT id, doc FROM ${quotedTable}`, [])) {
      const outcome = parseStored(row.doc);
      if (!outcome.ok) failures.push({ id: row.id, error: outcome.error });
    }
    return failures;
  }

  function deleteMany(where?: Where<TDocument>): number {
    const whereClause = compileWhere(where as Record<string, unknown> | undefined);
    const sql = [`DELETE FROM ${quotedTable}`, whereClause.sql]
      .filter((part) => part.length > 0)
      .join(" ");
    return database.query(sql).run(...whereClause.parameters).changes;
  }

  return {
    name,
    idField,
    insert,
    insertMany: (inputs) => runInsertMany(inputs),
    upsert,
    get,
    findByIds,
    find,
    findOne,
    count,
    update: (id, patch) => runUpdate(id, patch),
    replace: (id, input) => runReplace(id, input),
    delete: deleteById,
    deleteMany,
    validate,
  };
}
