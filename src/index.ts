// zodstore — a native SQLite + Zod document-store library for Bun.
//
// Zod is the gatekeeper: every document is validated on the way in and re-parsed
// on the way out. Each collection is one fixed table — (id TEXT PRIMARY KEY,
// doc TEXT NOT NULL) — so the shape lives in Zod and there are no migrations
// (declared defaults let old rows read forward). bun:sqlite drives it
// synchronously, in-process.

export { createStore } from "./store.ts";
export type {
  CheckpointMode,
  CheckpointResult,
  DocStore,
  JournalMode,
  StoreOptions,
  SynchronousMode,
} from "./store.ts";

export { transactionAcross } from "./cross-store.ts";
export type { AttachedStore } from "./cross-store.ts";

export { createCollection, DEFAULT_MAX_ROWS } from "./collection.ts";
export type {
  Collection,
  CollectionOptions,
  ParseErrorPolicy,
  ValidationFailure,
} from "./collection.ts";

export { populate } from "./populate.ts";
export type { Populated, ReferenceResolver } from "./populate.ts";

export { ref } from "./ref.ts";

export { dateParser } from "./date.ts";

export {
  compileWhere,
  compileOrderBy,
  compileLimitOffset,
  jsonExtract,
} from "./query.ts";
export type { CompiledClause } from "./query.ts";

export type {
  FieldCondition,
  FieldOperators,
  FieldPath,
  IndexDefinition,
  IndexInput,
  OrderBy,
  QueryOptions,
  SortDirection,
  SqlParameter,
  ValueAtPath,
  Where,
} from "./types.ts";
