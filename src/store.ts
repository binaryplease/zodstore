import { Database } from "bun:sqlite";
import type { z } from "zod";
import {
  type Collection,
  type CollectionOptions,
  createCollection,
  resolveMaxRows,
} from "./collection.ts";

/**
 * WAL checkpoint modes, in ascending order of aggressiveness. `PASSIVE` copies
 * what it can without blocking; `TRUNCATE` additionally shrinks the `-wal`
 * sidecar back to zero bytes once every frame is back in the main database.
 */
export type CheckpointMode = "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE";

/** The row `PRAGMA wal_checkpoint` returns. */
export interface CheckpointResult {
  /** 1 if the checkpoint was blocked by a busy reader/writer, 0 otherwise. */
  busy: number;
  /** Frames still in the WAL after the checkpoint. */
  log: number;
  /** Frames copied back into the main database. */
  checkpointed: number;
}

// PRAGMA arguments cannot be bound as parameters, so the statement text is
// looked up from this closed set rather than interpolated from the caller.
const CHECKPOINT_STATEMENTS: Record<CheckpointMode, string> = {
  PASSIVE: "PRAGMA wal_checkpoint(PASSIVE)",
  FULL: "PRAGMA wal_checkpoint(FULL)",
  RESTART: "PRAGMA wal_checkpoint(RESTART)",
  TRUNCATE: "PRAGMA wal_checkpoint(TRUNCATE)",
};

/**
 * SQLite journal modes. `WAL` is the default: it lets readers proceed while a
 * writer is active, which is what makes a single-file store usable in-process.
 */
export type JournalMode = "WAL" | "DELETE" | "TRUNCATE" | "PERSIST" | "MEMORY" | "OFF";

/**
 * The durability/latency trade-off. `NORMAL` is the correct pairing for WAL —
 * durable across process crashes, at risk of losing only the most recent
 * commits on an OS crash or power loss — and is what SQLite itself recommends
 * for WAL-mode application use. `FULL` fsyncs every autocommit write and costs
 * roughly two orders of magnitude of write throughput.
 */
export type SynchronousMode = "FULL" | "NORMAL" | "OFF";

// PRAGMA arguments cannot be bound as parameters, so every pragma whose value
// comes from a caller is resolved through a closed lookup map rather than
// interpolated — the same rule the checkpoint statements above follow.
const JOURNAL_MODE_STATEMENTS: Record<JournalMode, string> = {
  WAL: "PRAGMA journal_mode = WAL",
  DELETE: "PRAGMA journal_mode = DELETE",
  TRUNCATE: "PRAGMA journal_mode = TRUNCATE",
  PERSIST: "PRAGMA journal_mode = PERSIST",
  MEMORY: "PRAGMA journal_mode = MEMORY",
  OFF: "PRAGMA journal_mode = OFF",
};

// `synchronous` is a *per-database* pragma, so a connection holding attached
// files sets it once per attached schema — which is why this map holds the
// keyword rather than the whole statement, unlike the two above. The keyword
// still comes from a closed set; only the database name varies, and that is
// generated (`main`, `store_1`, …), never caller data.
const SYNCHRONOUS_KEYWORDS: Record<SynchronousMode, string> = {
  FULL: "FULL",
  NORMAL: "NORMAL",
  OFF: "OFF",
};

/** How long a blocked writer waits before giving up, in milliseconds. */
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/** Options for opening a document store. Every pragma defaults to its safe value. */
export interface StoreOptions {
  /**
   * SQLite database path. Defaults to `":memory:"` for an ephemeral in-process
   * store. Use a file path to persist.
   */
  path?: string;
  /** SQLite journal mode. Defaults to `"WAL"`. */
  journalMode?: JournalMode;
  /** Durability/latency trade-off. Defaults to `"NORMAL"`. */
  synchronous?: SynchronousMode;
  /**
   * How long a writer that finds the write lock held waits before throwing
   * `database is locked`, in milliseconds. Defaults to `5000`; `0` restores
   * SQLite's own give-up-immediately behaviour.
   */
  busyTimeoutMs?: number;
  /**
   * Rows a single `find()` with no explicit `limit` may return before it throws,
   * for every collection on this store. Defaults to `10_000`; `null` disables
   * the ceiling. An unbounded read of a large collection parses every row
   * through Zod and holds every result live at once, so it should be chosen —
   * by raising or disabling this — rather than defaulted into.
   */
  maxRows?: number | null;
}

/** The public surface of a document store. */
export interface DocStore {
  /**
   * Define (or reopen) a collection by name and schema. Idempotent: calling it
   * twice with the same name returns a collection over the same table.
   *
   * A reopen may extend the schema — that is the forward-compatibility path —
   * and may declare further indexes, which are cumulative across handles. It
   * may **not** change `idField`: identity is what the stored rows
   * are keyed and shaped by, so a conflicting reopen throws rather than writing
   * two conventions into one table.
   */
  collection<TSchema extends z.ZodType>(
    name: string,
    schema: TSchema,
    options?: CollectionOptions,
  ): Collection<z.input<TSchema>, z.output<TSchema>>;
  /**
   * Run a function inside a single SQLite transaction. The work is committed on
   * return and rolled back if the function throws.
   *
   * It covers **this store's connection and no other**. A callback that also
   * writes through a collection of a *different* store is only half inside a
   * transaction: the other store's write commits on its own statement, and a
   * throw here rolls back this half while leaving that one behind (F035). Use
   * `transactionAcross` when the work spans two stores — no ordering of the two
   * writes makes them atomic.
   */
  transaction<TResult>(work: () => TResult): TResult;
  /**
   * Run a WAL checkpoint. In WAL mode SQLite lets the `-wal` sidecar grow to a
   * high-water mark and then reuses it in place, so a long-lived writer can sit
   * behind a sidecar far larger than the database itself even though no frames
   * are outstanding. `TRUNCATE` is the mode that actually reclaims that space.
   * Defaults to `PASSIVE`, SQLite's own auto-checkpoint mode.
   */
  checkpoint(mode?: CheckpointMode): CheckpointResult;
  /** The underlying `bun:sqlite` database, for advanced/escape-hatch use. */
  readonly database: Database;
  /**
   * Close the database connection. In WAL mode this checkpoints and removes the
   * `-wal`/`-shm` sidecars, so a clean close is what keeps them from surviving
   * the process.
   */
  close(): void;
}

/** Look a pragma statement up by name, rejecting anything not in the map. */
function resolvePragmaStatement<TMode extends string>(
  statements: Record<TMode, string>,
  mode: TMode,
  pragmaName: string,
): string {
  if (!Object.hasOwn(statements, mode)) {
    const known = Object.keys(statements).join(", ");
    throw new Error(`Invalid ${pragmaName} ${JSON.stringify(mode)}: expected one of ${known}`);
  }
  return statements[mode];
}

/**
 * The largest value SQLite's PRAGMA parser accepts for `busy_timeout`. Above it
 * `sqlite3Atoi` yields 0 — which means *give up immediately*, the very defect a
 * busy timeout exists to close — so an over-large request is rejected here
 * rather than silently inverted into no wait at all.
 */
const MAX_BUSY_TIMEOUT_MS = 2_147_483_647;

/**
 * Compile `PRAGMA busy_timeout`. The value is a number rather than a member of a
 * closed set, so it is validated before interpolation — as an integer within the
 * range SQLite can actually represent, since out-of-range fails the unsafe way.
 */
function compileBusyTimeout(busyTimeoutMs: number): string {
  if (
    !Number.isInteger(busyTimeoutMs) ||
    busyTimeoutMs < 0 ||
    busyTimeoutMs > MAX_BUSY_TIMEOUT_MS
  ) {
    throw new Error(
      `Invalid busyTimeoutMs ${busyTimeoutMs}: expected an integer in 0…${MAX_BUSY_TIMEOUT_MS}`,
    );
  }
  return `PRAGMA busy_timeout = ${busyTimeoutMs}`;
}

/**
 * Compile `PRAGMA synchronous` for one database on a connection. `main` for a
 * store's own file; an attached schema name inside a cross-store transaction,
 * where each attached file carries the durability its own store asked for.
 */
export function compileSynchronous(databaseName: string, mode: SynchronousMode): string {
  const keyword = resolvePragmaStatement(SYNCHRONOUS_KEYWORDS, mode, "synchronous");
  return `PRAGMA "${databaseName}".synchronous = ${keyword}`;
}

/** The schema name SQLite gives a connection's own database file. */
export const MAIN_DATABASE_NAME = "main";

/**
 * A store's opening parameters, validated. Kept beside the store it opened so a
 * cross-store transaction can reopen the same file, with the same durability and
 * the same row ceiling, on a connection of its own — `transactionAcross` is the
 * only reader. Not part of the public surface.
 */
export interface ResolvedStoreOptions {
  path: string;
  journalMode: JournalMode;
  synchronous: SynchronousMode;
  busyTimeoutMs: number;
  maxRows: number | null;
}

/**
 * Resolve and validate every store option, so a bad one is refused before a
 * database is opened rather than after — no half-configured handle, no stray
 * file. A pragma that fails when *applied* is a different problem, handled in
 * `openConfiguredDatabase`.
 */
export function resolveStoreOptions(options: StoreOptions): ResolvedStoreOptions {
  const journalMode = options.journalMode ?? "WAL";
  const synchronous = options.synchronous ?? "NORMAL";
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  // Compiled for their validation and discarded; `openConfiguredDatabase`
  // compiles them again where it applies them, so there is one place that knows
  // what statement a mode becomes.
  resolvePragmaStatement(JOURNAL_MODE_STATEMENTS, journalMode, "journalMode");
  compileSynchronous(MAIN_DATABASE_NAME, synchronous);
  compileBusyTimeout(busyTimeoutMs);
  return {
    path: options.path ?? ":memory:",
    journalMode,
    synchronous,
    busyTimeoutMs,
    maxRows: resolveMaxRows(options.maxRows),
  };
}

/**
 * Open a `bun:sqlite` database and apply a store's pragmas to it. Shared by
 * `createStore` and by the connection a cross-store transaction runs on, so both
 * reach the same configured state.
 */
export function openConfiguredDatabase(resolved: ResolvedStoreOptions): Database {
  const database = new Database(resolved.path);
  // Applying a pragma can fail even when its value is valid — a journal-mode
  // conversion on a file another connection holds throws, and SQLite runs no
  // busy handler for it. The handle is already open by then, so it is closed
  // here rather than leaked: a long-running process that opens many stores would
  // otherwise accumulate dead descriptors until it runs out of them.
  try {
    database.run(resolvePragmaStatement(JOURNAL_MODE_STATEMENTS, resolved.journalMode, "journalMode"));
    database.run(compileSynchronous(MAIN_DATABASE_NAME, resolved.synchronous));
    database.run(compileBusyTimeout(resolved.busyTimeoutMs));
    // No `PRAGMA foreign_keys`: every collection is one (id TEXT PRIMARY KEY,
    // doc TEXT NOT NULL) table and no REFERENCES clause is ever emitted.
    // References are string ids inside the JSON document, validated by `ref()`
    // at the Zod gate — SQLite has no foreign key here to enforce.
  } catch (pragmaError) {
    database.close();
    throw pragmaError;
  }
  return database;
}

/**
 * What each store was opened with. Weak, so a dropped store is collectable, and
 * hung off the store object rather than exposed on it: a file path and a row
 * ceiling are `transactionAcross`'s business, not a knob on the public surface.
 */
const RESOLVED_STORE_OPTIONS = new WeakMap<DocStore, ResolvedStoreOptions>();

/** The options a store was opened with, or `undefined` if `createStore` did not open it. */
export function readResolvedStoreOptions(store: DocStore): ResolvedStoreOptions | undefined {
  return RESOLVED_STORE_OPTIONS.get(store);
}

/**
 * Create a document store backing one or more Zod-gated collections on a single
 * `bun:sqlite` database. Synchronous and in-process by design.
 */
export function createStore(options: StoreOptions = {}): DocStore {
  const resolved = resolveStoreOptions(options);
  const maxRows = resolved.maxRows;
  const database = openConfiguredDatabase(resolved);

  function collection<TSchema extends z.ZodType>(
    name: string,
    schema: TSchema,
    collectionOptions?: CollectionOptions,
  ): Collection<z.input<TSchema>, z.output<TSchema>> {
    // The store's ceiling is the default for every collection it opens; a
    // collection that names its own — including `null` — keeps it, which `??`
    // would not honour.
    return createCollection(database, name, schema, {
      ...collectionOptions,
      maxRows: collectionOptions?.maxRows === undefined ? maxRows : collectionOptions.maxRows,
    });
  }

  function transaction<TResult>(work: () => TResult): TResult {
    return database.transaction(work)();
  }

  function checkpoint(mode: CheckpointMode = "PASSIVE"): CheckpointResult {
    const statement = resolvePragmaStatement(CHECKPOINT_STATEMENTS, mode, "checkpoint mode");
    const row = database.query(statement).get() as CheckpointResult | null;
    // A non-WAL database still answers, with -1 frame counts. The `??` only
    // covers a driver that hands back no row at all.
    return row ?? { busy: 0, log: -1, checkpointed: -1 };
  }

  const store: DocStore = {
    collection,
    transaction,
    checkpoint,
    database,
    close: () => database.close(),
  };
  RESOLVED_STORE_OPTIONS.set(store, resolved);
  return store;
}
