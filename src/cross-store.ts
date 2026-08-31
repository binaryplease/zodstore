import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { z } from "zod";
import {
  type Collection,
  type CollectionOptions,
  createQualifiedCollection,
  exportTableBindings,
  importTableBindings,
} from "./collection.ts";
import {
  compileSynchronous,
  type DocStore,
  MAIN_DATABASE_NAME,
  openConfiguredDatabase,
  readResolvedStoreOptions,
  type ResolvedStoreOptions,
} from "./store.ts";

/**
 * One store, addressed from inside a cross-store transaction. It opens
 * collections exactly as a `DocStore` does, over the same file, with the same
 * row ceiling — the difference is that its writes go through the transaction's
 * connection instead of the store's own.
 *
 * It has no `transaction`, `checkpoint` or `close` of its own: a transaction is
 * already running, and the connection under it belongs to `transactionAcross`.
 */
export interface AttachedStore {
  /**
   * Define (or reopen) a collection on this store, as `store.collection` does.
   * The handle is valid for the duration of the transaction only.
   */
  collection<TSchema extends z.ZodType>(
    name: string,
    schema: TSchema,
    options?: CollectionOptions,
  ): Collection<z.input<TSchema>, z.output<TSchema>>;
}

/**
 * One `AttachedStore` per store given, positionally. A tuple in, a tuple out, so
 * `([ordersTx, inventoryTx]) => …` destructures to handles rather than to
 * `AttachedStore | undefined` — the arity is known at the call site and the
 * types say so. That is what the `const` type parameter on `transactionAcross`
 * buys: without it an array literal infers as `DocStore[]` and the arity is lost.
 */
export type AttachedHandles<TStores extends readonly DocStore[]> = {
  [Position in keyof TStores]: AttachedStore;
};

/**
 * The paths SQLite reads as "a database private to this connection" — an
 * explicit `:memory:`, and the empty string, which opens an anonymous temporary
 * file. Neither can be reached from another connection, so neither can be
 * attached.
 */
const CONNECTION_PRIVATE_PATHS = new Set([":memory:", ""]);

/**
 * `SQLITE_LIMIT_ATTACHED`, SQLite's compile-time ceiling on attached databases —
 * 10 in the build Bun ships, and 10 in SQLite's own default. One store is the
 * connection's `main`, so the ceiling on stores is one higher. Refused here by
 * name: past it SQLite throws `too many attached databases - max 10` from the
 * middle of the attach loop, which is safe (nothing is written) but names
 * neither this function nor where the number comes from.
 */
const MAX_ATTACHED_DATABASES = 10;
const MAX_STORES = MAX_ATTACHED_DATABASES + 1;

/** The schema name the n-th store is attached under. Generated, never supplied. */
function attachedDatabaseName(index: number): string {
  return `store_${index}`;
}

/** Read what a store was opened with, refusing anything that cannot be attached. */
function readAttachableOptions(store: DocStore, index: number): ResolvedStoreOptions {
  const resolved = readResolvedStoreOptions(store);
  if (resolved === undefined) {
    throw new Error(
      `transactionAcross(): the store at index ${index} was not opened by createStore(), ` +
        `so the file behind it is unknown and cannot be attached.`,
    );
  }
  if (CONNECTION_PRIVATE_PATHS.has(resolved.path)) {
    throw new Error(
      `transactionAcross(): the store at index ${index} is in-memory ` +
        `(path ${JSON.stringify(resolved.path)}). An in-memory database belongs to the ` +
        `connection that opened it, and attaching that path would silently open a ` +
        `second, empty one — every write would land there. Give every store a file path.`,
    );
  }
  return resolved;
}

/**
 * The file a store's path actually names. Symlinks are followed, because two
 * paths that resolve to one file are one file to SQLite — and reaching that file
 * twice is what this refusal exists to catch. A path that cannot be resolved
 * (the file was removed under the open handle) falls back to the lexical form
 * rather than throwing something unrelated out of a guard.
 */
function realPathOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Refuse the same file twice: SQLite would attach it under two names and deadlock on it. */
function assertDistinctFiles(openings: ResolvedStoreOptions[]): void {
  const firstAtPath = new Map<string, number>();
  for (const [index, opening] of openings.entries()) {
    const absolutePath = realPathOf(opening.path);
    const firstIndex = firstAtPath.get(absolutePath);
    if (firstIndex !== undefined) {
      throw new Error(
        `transactionAcross(): the stores at index ${firstIndex} and ${index} are the same ` +
          `file (${absolutePath}). One file attached twice is two independent writers on ` +
          `one connection, which deadlocks against itself; pass each file once and open ` +
          `both collections on the handle you get back.`,
      );
    }
    firstAtPath.set(absolutePath, index);
  }
}

/**
 * Refuse a set of stores whose journal modes disagree.
 *
 * The atomicity of a multi-file commit is a property of the *transaction*, not of
 * one file in it: if any attached database is in WAL, the commit is not atomic
 * and the crash window is open for the whole set. And `transactionAcross` sets no
 * journal mode on an attached file — an attached database keeps whatever its own
 * header says — so a mixed set would leave a caller who deliberately took the
 * documented non-WAL escape hatch with the guarantee they were escaping, and no
 * way to tell. The weakest member decides, so the set has to agree.
 */
function assertOneJournalMode(openings: ResolvedStoreOptions[]): void {
  // Non-null: every caller checks for an empty list before reaching here.
  const hostOpening = openings[0] as ResolvedStoreOptions;
  for (const [index, opening] of openings.entries()) {
    if (opening.journalMode === hostOpening.journalMode) continue;
    throw new Error(
      `transactionAcross(): the store at index ${index} is in journalMode ` +
        `"${opening.journalMode}" but the store at index 0 is in ` +
        `"${hostOpening.journalMode}". Atomic commit across attached databases is a ` +
        `property of the whole transaction and the weakest member decides it — a mixed ` +
        `set silently gives every file WAL's guarantee. Open every store in the same ` +
        `journal mode.`,
    );
  }
}

/**
 * Run `work` inside **one** SQLite transaction spanning several stores. Every
 * store's file is attached to a single connection, so a throw rolls all of them
 * back and a return commits all of them — which `store.transaction` cannot do,
 * because it covers the one connection it was called on and lets the other
 * store's write commit past it (F035).
 *
 * The callback is handed one handle per store, in the order the stores were
 * given, and **only those handles are inside the transaction**:
 *
 * ```ts
 * transactionAcross([orders, inventory], ([ordersTx, inventoryTx]) => {
 *   const stockLevels = inventoryTx.collection("stockLevels", StockLevelSchema);
 *   const orderRows = ordersTx.collection("orders", OrderSchema);
 *   stockLevels.update("stk_widget", { onHand: 41 });
 *   orderRows.insert({ id: "ord_1" });
 * });
 * ```
 *
 * A collection opened on the outer `orders`/`inventory` objects is not: it writes
 * on that store's own connection, which is the very defect this exists to close.
 * It does not get to do so quietly, though — the transaction holds the write lock
 * on every file it spans, so an outer write waits out *that store's* own
 * `busyTimeoutMs` and then throws `database is locked`. The handles themselves
 * stop working when the transaction returns.
 *
 * **The limit, because it is part of what is being promised.** SQLite commits
 * attached databases atomically only when the journal mode is **not** WAL
 * (`sqlite.org/lang_attach.html`), and this library defaults to WAL. Under WAL
 * each file commits separately, so:
 *
 * - the **error path is closed** — a throw rolls every file back, which is the
 *   common case and the whole reason this exists;
 * - the **crash window is not** — a process or machine that dies between two
 *   file commits leaves the earlier file committed and the later one not.
 *
 * Order the writes so that window fails in the direction you can live with, or
 * open **every** store with a `journalMode` other than `"WAL"`, where SQLite's
 * master journal makes the multi-file commit atomic outright. Every store: an
 * attached database keeps the journal mode its own header says, and the weakest
 * member decides the commit, so a set whose modes disagree is refused rather
 * than quietly given WAL's guarantee.
 *
 * What it refuses, all before anything is opened: an empty list; a store
 * `createStore` did not open; an in-memory store, in any position; the same file
 * twice, symlinks resolved; more than 11 stores, because SQLite attaches at most
 * 10 databases to a connection and one store is the connection's own; and a set
 * whose journal modes disagree.
 *
 * The transaction runs on a connection of its own — `BEGIN IMMEDIATE`, so it takes
 * every write lock up front — which means a store already holding a write
 * transaction on its own connection makes this wait and then fail loudly, rather
 * than half-writing. That wait is the **host's** `busyTimeoutMs`, taken from the
 * first store in the list: `busy_timeout` is a per-connection pragma, so a set of
 * stores with differing timeouts is governed by `stores[0]`'s.
 */
export function transactionAcross<const TStores extends readonly DocStore[], TResult>(
  stores: TStores,
  work: (attached: AttachedHandles<TStores>) => TResult,
): TResult {
  if (stores.length === 0) {
    throw new Error(
      "transactionAcross(): no stores given. Name every store the work writes through — " +
        "a store left out is a write outside the transaction.",
    );
  }
  if (stores.length > MAX_STORES) {
    throw new Error(
      `transactionAcross(): ${stores.length} stores given, but SQLite attaches at most ` +
        `${MAX_ATTACHED_DATABASES} databases to a connection (SQLITE_LIMIT_ATTACHED) and one ` +
        `store is that connection's own — so ${MAX_STORES} is the ceiling. Split the work, ` +
        `or move the collections that must be atomic into fewer files.`,
    );
  }
  const openings = stores.map(readAttachableOptions);
  assertDistinctFiles(openings);
  assertOneJournalMode(openings);
  // Non-null: the emptiness check above is what guarantees there is a first one.
  const hostOpening = openings[0] as ResolvedStoreOptions;

  // A connection of its own rather than the first store's. Two properties come
  // out of that and both matter: no outer collection handle can accidentally be
  // inside the transaction (all stores are equal — every one of them is reached
  // through the callback's handles), and the attach/detach never touches a
  // long-lived connection's prepared-statement cache. It is closed on the way
  // out, so a handle kept past the callback fails loudly instead of writing
  // outside a transaction.
  //
  // `main` is a real file rather than `:memory:` deliberately: SQLite writes the
  // master journal that makes a multi-file commit atomic next to the main
  // database, and a memory main would forfeit that even in a non-WAL journal
  // mode.
  const host = openConfiguredDatabase(hostOpening);
  try {
    for (const [index, opening] of openings.entries()) {
      if (index === 0) continue;
      const databaseName = attachedDatabaseName(index);
      // The path binds as a parameter; the schema name is generated here.
      host.query(`ATTACH DATABASE ? AS "${databaseName}"`).run(opening.path);
      // `synchronous` is per-database, so each attached file gets the durability
      // its own store asked for rather than the host store's.
      host.run(compileSynchronous(databaseName, opening.synchronous));
    }

    // The identity conventions each store has already pinned, carried onto this
    // connection. Without this the `idField` reopen guard would be structurally
    // unreachable here rather than merely weakened: the guard's registry hangs
    // off the `Database` object, and this one is opened per call, so it would
    // start empty every time and accept a reopen the store itself refuses —
    // leaving one table holding two identity conventions, with a delete-by-id
    // that answers `false` while the row stays readable through `find()`.
    const databaseNameOf = (index: number): string =>
      index === 0 ? MAIN_DATABASE_NAME : attachedDatabaseName(index);
    for (const [index, store] of stores.entries()) {
      importTableBindings(
        host,
        databaseNameOf(index),
        exportTableBindings(store.database, MAIN_DATABASE_NAME),
      );
    }

    const attached = openings.map((opening, index): AttachedStore => {
      const databaseName = databaseNameOf(index);
      return {
        collection: (name, schema, collectionOptions) =>
          createQualifiedCollection(host, databaseName, name, schema, {
            ...collectionOptions,
            // The store's ceiling is the default for every collection it opens;
            // a collection naming its own — including `null` — keeps it, which
            // `??` would not honour. Same rule as `store.collection`.
            maxRows:
              collectionOptions?.maxRows === undefined
                ? opening.maxRows
                : collectionOptions.maxRows,
          }),
      };
    });

    // `.immediate` — BEGIN IMMEDIATE takes the write lock on every attached
    // database at the start rather than on first write, so contention fails
    // before anything is written instead of during a lock upgrade halfway
    // through.
    // The cast is the one place the positional mapping is asserted: `attached`
    // is built by mapping `openings`, which is built by mapping `stores`, so it
    // has exactly the arity the tuple type promises.
    const result = host.transaction(() => work(attached as AttachedHandles<TStores>)).immediate();

    // And back the other way, so the carry-over is symmetric: a table first
    // opened inside a transaction has pinned its identity convention for the
    // store too. Only after a commit — a rolled-back transaction created no
    // table, so it has nothing to pin.
    for (const [index, store] of stores.entries()) {
      importTableBindings(
        store.database,
        MAIN_DATABASE_NAME,
        exportTableBindings(host, databaseNameOf(index)),
      );
    }
    return result;
  } finally {
    host.close();
  }
}
