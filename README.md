# zodstore

A native **SQLite + Zod** document-store library for Bun. Zod is the gatekeeper;
SQLite (`bun:sqlite`) is the synchronous, in-process engine. No migrations, no ORM —
the shape lives in Zod, the rows live in SQLite.

## Design

### Core

- **Zod is the gatekeeper.** Every document is validated on the way in and re-parsed
  on the way out. Everything that crosses the boundary is validated.
- **Nothing is written that cannot be read back as it was written.** The write gate
  refuses a document whose stored JSON its own schema would reject, or would re-parse
  into something different — see [the write gate](#the-write-gate).
- **One fixed table per collection:** `(id TEXT PRIMARY KEY, doc TEXT NOT NULL)`. The
  shape lives in Zod, so there are **no migrations** — old rows read forward via schema
  defaults, because every non-identity field declares a `.default(...)`.
- **`json_extract` expression indexes** for declared index fields; filters compile to
  matching predicates.
- **`bun:sqlite`, synchronous, in-process.** Native API, a real typed where-clause,
  transactions, `count`, and batch operations.

### Joins

Batched populate is the default join API:

- **`findByIds(ids)`** — one `IN` query, gated and deduped.
- **`populate(parents, foreignKey, target, as)`** — a resolver over `findByIds` that
  dedups ids (each referenced doc is parsed once) and emits `null` for missing refs.
- **`ref(prefix)`** — a schema helper so references are typed and validated at the gate.

## Install

`@binaryplease/zodstore` is a Bun-native library. Zod is a peer dependency, so
install both:

```bash
bun add @binaryplease/zodstore zod
```

It imports `bun:sqlite`, so it runs under Bun only — not Node.

The package ships TypeScript sources rather than a compiled bundle: `exports` points
at `src/index.ts`, which Bun imports directly and which is also where the types come
from. There is no build step to run and no `dist/` to configure.

## Quick start

```ts
import { z } from "zod";
import { createStore, populate, ref } from "@binaryplease/zodstore";

// Schemas are the single source of truth. Every non-identity field declares a
// default so old rows read forward without migration.
const UserSchema = z.object({
  id: ref("user"),                       // identity — required, fails loudly if absent
  name: z.string().default(""),
  age: z.number().default(0),
  active: z.boolean().default(true),
  nickname: z.string().nullable().default(null),
});

const PostSchema = z.object({
  id: ref("post"),
  authorId: ref("user"),                 // typed, validated foreign key
  title: z.string().default(""),
  views: z.number().default(0),
});

const store = createStore({ path: "data.sqlite" }); // omit path for an in-memory store

const users = store.collection("users", UserSchema, {
  indexes: ["age", { fields: ["active"], unique: false }],
});
const posts = store.collection("posts", PostSchema, { indexes: ["authorId"] });

users.insert({ id: "user_alice", name: "Alice", age: 30 });
posts.insert({ id: "post_1", authorId: "user_alice", title: "Hello" });
```

### Reads, writes, and a typed where-clause

```ts
users.get("user_alice");                 // → full document, or null

users.find({
  where: { active: true, age: { gte: 18, lt: 65 } },
  orderBy: { field: "age", direction: "desc" },
  limit: 20,
  offset: 0,
});

users.findOne({ where: { name: "Alice" } });
users.count({ active: true });
users.validate();                        // → [{ id, error }] for rows the schema now rejects

users.update("user_alice", { age: 31 }); // shallow-merge + re-validate; null if absent
users.replace("user_alice", { id: "user_alice", name: "Alice II" });
users.upsert({ id: "user_bob", name: "Bob" });
users.delete("user_alice");              // → boolean
users.deleteMany({ active: false });     // → number removed
```

Where-clause operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`, `contains`,
`startsWith`, `endsWith`, `like`, `isNull`. A bare value is shorthand for `eq`. `null`
(or `{ eq: null }`) compiles to `IS NULL`; `{ ne: null }` / `{ isNull: false }` to
`IS NOT NULL`. A `Date` operand binds as the ISO string it is stored as, so a
range query over a `dateParser` field — `{ at: { gt: new Date("2026-01-01") } }` —
and an `orderBy` over it answer chronologically; an invalid `Date`, or one
outside years 0000–9999 (whose expanded ISO form would not order against stored
timestamps — `dateParser` refuses to store one either), is refused naming the
operator or field at fault.

### An absent value narrows

**A condition whose value is `undefined` matches nothing.** Filters get built from state
that may not be loaded yet, and the alternative — dropping the condition — turns a filter
into its opposite:

```ts
const currentUser: string | undefined = undefined;      // session not loaded yet

cases.find({ where: { assignee: currentUser } });       // → [] , not every case
cases.count({ assignee: currentUser });                 // → 0
cases.deleteMany({ assignee: currentUser });            // → 0 rows deleted, not all of them
```

The rule holds wherever the value goes missing: in an operator object
(`{ age: { gte: undefined } }`) and beside a live sibling (`{ status: "open", assignee:
undefined }` matches nothing rather than every open case).

**A gap can never be negated into a match.** A clause carrying a missing value anywhere
below it compiles to "no rows" under `NOT` rather than being negated, at any depth:

```ts
// "delete everything except mine and the unassigned" — the retention shape
cases.deleteMany({ NOT: { OR: [{ assignee: currentUser }, { assignee: null }] } });
// → 0 rows deleted while `currentUser` is unset, not "everything except the unassigned"
```

That case is worth stating separately because the disjunction is still a *usable* filter in
positive position — `OR: [{ assignee: currentUser }, { assignee: null }]` returns the
unassigned rows, and keeping that is deliberate. Negation inverts it: the branch that
narrowed the disjunction widens its complement by exactly the rows the missing condition
existed to protect. So whether a clause is usable and whether it is safe to negate are two
different questions, and `NOT` asks the stricter one. An *explicit* `OR: []` decided "no
rows" with nothing missing, so `NOT: { OR: [] }` still matches every row.

To mean "no filter", say so: omit `where`, or pass `{}`. Only a clause that names no key
at all matches everything, which is what keeps `deleteMany({})` meaningful.

To make a condition genuinely optional, leave the key out rather than setting it to
`undefined`:

```ts
const where = { status: "open", ...(assignee !== undefined && { assignee }) };
```

### Substring matching

`contains`, `startsWith`, and `endsWith` **escape their operand**: `%` and `_` are
ordinary characters in names, paths, and case references, and a search box that turns
`%` into a full-collection scan is a cheap way to make a server unresponsive.

```ts
users.find({ where: { name: { contains: "50%" } } });   // matches a literal "50%"
users.find({ where: { name: { startsWith: "Al" } } });
```

`like` is the raw escape hatch and means what SQL means — the operand *is* the pattern,
wildcards and all. It compiles with `ESCAPE '\'`, so an expert can still match a literal:

```ts
users.find({ where: { name: { like: "A%" } } });        // wildcard, as written
users.find({ where: { name: { like: "%\\%%" } } });     // a literal "%" anywhere
users.find({ where: { name: { like: "C:\\\\%" } } });   // a literal backslash, doubled
```

Because `\` is the escape character, a **literal backslash in a `like` pattern must be
doubled** — an undoubled one escapes the character after it. `contains`, `startsWith`,
and `endsWith` do that for you; only the raw `like` operand is yours to escape.

None of these can use an index — a `json_extract` expression index serves equality and
range, and a leading-wildcard `LIKE` cannot use one at all. A substring filter scans, so
pair it with a `limit` on a large collection.

### Nested paths

Anywhere a field is named — `where`, `orderBy`, and `indexes` — a **dotted path** into a
nested object works and is typed, up to three levels (`a`, `a.b`, `a.b.c`). A typo is a
compile error rather than a clause that silently matches nothing:

```ts
const PlaceSchema = z.object({
  id: ref("place"),
  address: z
    .object({
      city: z.string().default(""),
      geo: z.object({ zone: z.string().default("") }).default({ zone: "" }),
    })
    .default({ city: "", geo: { zone: "" } }),
});

const places = store.collection("places", PlaceSchema, { indexes: ["address.city"] });

places.find({
  where: { "address.city": "Berlin", "address.geo.zone": { in: ["east"] } },
  orderBy: { field: "address.city" },
});
```

The three-level bound is a compile-time budget, not a runtime one: deeper paths still
work through `compileWhere`/`jsonExtract` directly, they are simply not offered by the
typed surface, where unbounded recursion would blow TypeScript's instantiation limit.

### `OR` and `NOT`

Sibling keys of a `where` are joined with `AND`. Two reserved keys combine clauses
instead of naming a field, and they nest:

```ts
users.find({
  where: { active: true, OR: [{ nickname: "mine" }, { nickname: null }] },
  orderBy: { field: "age", direction: "desc" },
  limit: 20,
});

users.find({ where: { NOT: { OR: [{ age: { lt: 30 } }, { age: { gt: 40 } }] } } });
```

The `orderBy` and `limit` above apply across the whole union — the property two `find()`
calls merged in JavaScript cannot give you, because you cannot page a union assembled
after the fact.

**A combinator fails closed.** An empty `OR: []` matches nothing, as an empty `in` does,
and so does a *branch* that carries no condition:

```ts
const currentUser: string | undefined = undefined;      // session not loaded yet
cases.find({ where: { OR: [{ assignee: currentUser }, { assignee: null }] } });
// → the unassigned rows only. The empty branch matches nothing rather than everything.
```

An empty `NOT: {}` matches nothing for the same reason, by the other route: it negates a
clause that matches everything.

`NOT` is SQL's `NOT`, with SQL's three-valued logic: `NOT { name: "Ann" }` does not match
a row whose `name` is `null`, because `null = 'Ann'` is unknown rather than false. Say
`{ OR: [{ NOT: { name: "Ann" } }, { name: null }] }` when you want the nulls too.

The keys are uppercase so they cannot be mistaken for fields, and `store.collection(...)`
refuses an **object** schema carrying a field named `OR` or `NOT`. A schema whose shape it
cannot read — one wrapped in `.transform()`, `.pipe()`, or a union — is not walked, so
that guard is a strong default rather than a proof; do not name a field `OR` or `NOT`.

A `where` is a nested, JSON-shaped structure, and it is a plain TypeScript type rather
than a Zod schema — the deliberate in-process exception to Zod owning every shape,
because a `where` is assembled from already-validated input. **Never pass an unvalidated request
body as `where`** — parse it into the shape your handler intends first.

### The result ceiling

A `find()` with no `limit` selects every matching row and parses each one through Zod
into memory. That read is legitimate — an export job wants every row — but it should be
*chosen*, not defaulted into, so it is capped at `maxRows` (default `10_000`) and
**throws rather than truncates** when the cap is exceeded: a silently truncated result
is a wrong answer.

```ts
createStore({ maxRows: 50_000 });        // raise it
createStore({ maxRows: null });          // disable it
users.find({ limit: 100, offset: 0 });   // an explicit bound is the caller's own
// otherwise: find() on "users" returned more than maxRows (10000). Pass an explicit
// limit, paginate, or raise/disable maxRows on the store.
```

### When a stored row no longer parses

Reads re-parse, so a schema change that is *not* an added defaulted field — tightening
a type, narrowing an enum — can strand a row written under the old schema. The default
policy is to throw, naming the row:

```
Collection "docs": stored row "p_2" does not match the current schema. …
```

The blast radius is that row, not the collection. Two ways past it:

```ts
store.collection("docs", Schema, { onParseError: "skip" });
// find()/findByIds() omit the row, get() returns null, findOne() steps over it
// to the first readable match. The row is still there.

store.collection("docs", Schema).validate();
// → [{ id: "p_2", error: ZodError }] — reads only, throws nothing, streams the table.
```

`validate()` is the repair primitive: it turns "the collection is broken" into a list of
ids to act on, without dropping to `store.database` and hand-written SQL.

**`"skip"` is a read-for-repair mode, not a paging mode.** The filter runs *after* SQL
has applied `LIMIT`, so a page containing a skipped row comes back short:

```ts
// rows p_1 (stale), p_2, p_3 under { onParseError: "skip" }
docs.find();              // → [p_2, p_3]
docs.find({ limit: 2 });  // → [p_2]      ← a short page, not an error
docs.findOne();           // → p_2        ← steps over p_1 to the first readable match
docs.count();             // → 3          ← count() answers from SQL, Zod uncalled
```

The short page is a deliberate cost: `limit`/`offset` page over *stored* rows, and paging
over readable rows instead would make every page's `offset` require parsing the whole
table ahead of it. `findOne()` is the exception, because there is no page to keep
consistent — it streams to the first readable match, so a `null` still means "no match"
rather than "the first match was skipped".

Use it to read past damage while `validate()` tells you what to repair, then go back to
`"throw"`. Writes never skip: `update()` on a row whose stored JSON is malformed throws,
naming the collection and the row, whatever the policy says.

### Batched joins

```ts
const allPosts = posts.find();
const withAuthors = populate(allPosts, "authorId", users, "author");
// withAuthors[i].author is a fully-parsed user document, or null for a missing ref.

users.findByIds(["user_alice", "user_bob", "user_alice"]); // deduped, order-preserving
```

`populate` resolves every distinct reference in a single `findByIds` query, so each
target document is fetched and parsed exactly once. Missing references become an
explicit `null` key, never a dropped property: nullish properties are emitted, so a
caller always sees the full shape.

### Transactions

```ts
store.transaction(() => {
  users.insert({ id: "user_carol" });
  posts.insert({ id: "post_2", authorId: "user_carol" });
}); // committed on return, rolled back if the body throws

users.insertMany([{ id: "user_d" }, { id: "user_e" }]); // atomic batch insert
```

`store.transaction` covers **the connection it was called on and no other**. A callback
that also writes through a collection of a *different* store is only half inside a
transaction: the other store's write commits on its own statement, and a throw rolls
back this half while leaving that one behind. There is no ordering of the two writes
that makes them atomic — reverse them and the surviving row is the other one.

### Cross-store transactions

`transactionAcross` is the primitive for work that spans two files. It attaches every
store's database to a single connection, so one transaction covers all of them:

```ts
const orders = createStore({ path: "orders.sqlite" });
const inventory = createStore({ path: "inventory.sqlite" });

transactionAcross([orders, inventory], ([ordersTx, inventoryTx]) => {
  inventoryTx.collection("stockLevels", StockLevelSchema).update("stk_widget", { onHand: 41 });
  ordersTx.collection("orders", OrderSchema).insert({ id: "ord_1" });
}); // both files committed on return, both rolled back if the body throws
```

The callback gets one handle per store, in the order the stores were given, and **only
those handles are inside the transaction**. A collection opened on the outer `orders`
or `inventory` object writes on that store's own connection — it does not get to do so
quietly, because the transaction holds the write lock on every file it spans, so such a
write waits out its `busyTimeoutMs` and then throws `database is locked`. The handles
stop working once the transaction returns.

> **The limit, because it is part of what is being promised.** SQLite commits attached
> databases atomically **only when the journal mode is not WAL**
> ([`lang_attach.html`](https://sqlite.org/lang_attach.html)) — and WAL is this library's
> default. Under WAL each file commits separately, so the **error path is closed** (a
> throw rolls every file back, which is the common case and the reason this exists) but
> the **crash window is not**: a process or machine that dies between two file commits
> leaves the earlier file committed and the later one not.
>
> Order the writes so that window fails in the direction you can live with, or open
> **every** store with a `journalMode` other than `"WAL"`, where SQLite's master
> journal makes the multi-file
> commit atomic outright. Every store: an attached database keeps the journal mode its
> own header says, and the weakest member decides the commit.

What it refuses, all before anything is opened:

| Refused | Why |
| --- | --- |
| An empty list | A store left out is a write outside the transaction. |
| A store `createStore` did not open | The file behind it is unknown, so it cannot be attached. |
| An in-memory store, in any position | `ATTACH ':memory:'` opens a *second*, empty database rather than reaching the store's — every write would land there and vanish at close. |
| The same file twice (symlinks resolved) | One file attached twice is two writers on one connection, which deadlocks against itself. |
| More than 11 stores | `SQLITE_LIMIT_ATTACHED` is 10 and one store is the connection's own `main`. |
| A set whose `journalMode`s disagree | The mixed set would silently give every file WAL's guarantee, including to a caller who took the escape hatch above. |

The transaction runs on a connection of its own, under `BEGIN IMMEDIATE`, so it takes
every write lock up front and contention fails before anything is written rather than
halfway through. `busy_timeout` is per-connection, so that wait is `stores[0]`'s
`busyTimeoutMs`; a write attempted through an *outer* store while the transaction is
open waits out that store's own.

### WAL checkpoints

```ts
store.checkpoint();                      // PASSIVE — what SQLite's auto-checkpoint does
store.checkpoint("TRUNCATE");            // → { busy, log, checkpointed }; sidecar back to zero bytes
```

In WAL mode SQLite lets the `-wal` sidecar grow to a high-water mark and then
reuses it in place, so a long-lived writer can sit behind a sidecar far larger than
the database itself even though no frames are outstanding. `TRUNCATE` is the mode
that actually reclaims that space. `PASSIVE` (the default) copies what it can
without blocking; `FULL` and `RESTART` sit between the two.

The result is SQLite's own row: `busy` is 1 if a reader or writer blocked the
checkpoint, `log` the frames still in the WAL, `checkpointed` the frames copied back
into the main database. A database that is not in WAL mode — an in-memory store, or
one opened with `journalMode: "DELETE"` — answers with `-1` counts rather than
failing, so the call is safe to make unconditionally.

`close()` already checkpoints and removes the `-wal`/`-shm` sidecars, so a process
that is exiting cleanly needs nothing extra. Reach for `checkpoint("TRUNCATE")` when
the handle *stays open* but the file should shrink — before copying a database file
somewhere, for instance.

## Forward compatibility (no migrations)

Because every non-identity field declares a `.default(...)`, you extend a schema by
appending a defaulted field — no migration, no backfill. Rows written under the old
schema parse cleanly under the new one, with the default filling the gap at read time:

```ts
// v1 wrote: { id: "user_legacy", name: "Legacy" }
const UsersV2 = z.object({
  id: ref("user"),
  name: z.string().default(""),
  role: z.enum(["admin", "member"]).default("member"), // new field
});
store.collection("users", UsersV2).get("user_legacy");
// → { id: "user_legacy", name: "Legacy", role: "member" }
```

Identity fields (`id`, foreign keys) carry no default and fail loudly when absent —
a fabricated id is worse than a missing one. They are the honest exception to the
default rule.

Reopening a collection may extend the schema and may declare further indexes, which are
cumulative across handles. It may **not** change `idField`: identity is what the stored
rows are keyed and shaped by, so a conflicting reopen throws instead of writing two
conventions into one table.

```ts
store.collection("ks", z.object({ id: ref("k") }));
store.collection("ks", z.object({ slug: ref("k") }), { idField: "slug" });
// throws: collection("ks"): already open with idField "id", cannot reopen with "slug".
```

The check is case-insensitive, because SQLite identifiers are — `"KS"` and `"ks"` are one
table and so one binding. It is also **in-process only**: the binding lives in memory, so
a second connection to the same file does not yet see it (tracked as F018).

That rule is **enforced, not documented**: `store.collection(...)` walks an object
schema once at creation and refuses a non-identity field with no `.default(...)`,
naming the field. A field with no default is not merely un-forward-compatible — its
`undefined` is dropped by `JSON.stringify`, so the key disappears from the stored row
entirely and the key set varies row to row, which is exactly the incompleteness a
stored document must never have. Pass
`{ enforceDefaults: false }` for a deliberate exception; a non-object schema has no
shape to walk and is skipped.

Because it defaults to `true`, this is a **breaking change for an existing schema**:
every optional field without a default now throws at `store.collection(...)` rather
than silently vanishing from storage. That includes `ref("user").optional()`, the
natural spelling of a nullable foreign key — the identity exemption is carried by the
schema object `ref()` returns, so any wrapper drops it. Write it
`ref("user").nullable().default(null)`, which stores the explicit `null` you want anyway.
Expect a batch of these the first time an existing consumer upgrades; fix them at the
schema, or pass `{ enforceDefaults: false }` to stage the migration.

## The write gate

Reads re-parse the stored JSON, so a document is only storable if its stored form
survives that trip intact. Every write asserts both halves and throws, naming the
collection, if either fails:

1. **The stored form must pass the schema.** `z.date()` does not: it is written as an
   ISO string and rejected by its own schema on the way back, leaving a row that no
   read can ever return. Declare timestamps with **`dateParser`** — a `Date` passes
   through, an ISO string is rehydrated into a `Date`.
2. **The stored form must parse back to itself, by type as well as by value.** A
   schema whose parse *rewrites* an already-parsed value (`z.number().transform((n) =>
   n + 1)`) would drift on every read and compound on every update. Transforms and
   coercions are fine as long as they are idempotent — `z.coerce.number()` and
   `.toUpperCase()` are, `+ 1` is not. The comparison is structural, not a byte
   comparison, so it also catches a value whose *type* changes while its bytes do
   not: a `Date` under `z.record(…, z.unknown())` or `z.union([z.string(), z.date()])`
   serialises to a string the schema happily accepts and then reads back as a
   `String`. Store it as `dateParser`, or as the string it reads back as.

A refusal names the **field paths** that failed and never the values at them:
documents are consumer data, and an uncaught throw would otherwise put whole records
into a log.

```ts
const EventSchema = z.object({
  id: ref("evt"),
  at: dateParser.default(() => new Date()),   // stored "2020-01-01T00:00:00.000Z", read as a Date
  note: z.string().default(""),
});

store.collection("events", z.object({ id: ref("evt"), at: z.date().default(new Date(0)) }))
  .insert({ id: "evt_1", at: new Date() });
// throws: Collection "events": document does not survive a JSON round-trip …
```

The cost is one extra parse per write. It buys the property the store's whole premise
rests on: what a read returns is what a write stored, on every read, forever.

`update(id, patch)` merges the patch into the **stored** document rather than into the
parsed result of a read (parsed output is `z.output`; feeding it back as `z.input`
re-applies the schema), and runs the whole read-merge-write inside a `BEGIN IMMEDIATE`
transaction, so it holds the write lock across both statements. A second connection
racing the same row waits out its `busyTimeoutMs` and then fails loudly — it never has
its committed change silently overwritten. `replace` takes the write lock the same way.

**A patch key holding `undefined` is not supplied**, and leaves the stored value alone —
the same reading a `where` gives an absent value, so a patch built from optional inputs
cannot erase a field it never mentioned:

```ts
users.update("user_alice", { name: form.name, age: 31 });  // form.name?: string
// → age is 31; name keeps whatever was stored, even when form.name is undefined
```

To *clear* a field, name the value you want it cleared to — `{ nickname: null }` on a
nullable field, or the empty value the schema takes. This matters because every
non-identity field carries a `.default(...)`: were an `undefined` assigned, `JSON.stringify`
would drop the key and that default would quietly refill it, replacing a stored value with
no error and no trace. The rule covers `ref()` foreign keys too — an `undefined` there
keeps the stored reference instead of failing the parse.

`replace(id, input)` is the wholesale form and is unaffected: it is a whole new document,
so a field omitted there does take its schema default. Under the default
`enforceDefaults: true` that is a convenience; under `{ enforceDefaults: false }` it is the
**only** way to clear a field that declares no default, since such a field rests at
`undefined` and `update()` has no value left to name.

## API

| Export | Purpose |
| --- | --- |
| `createStore(options?)` | Open a store over one `bun:sqlite` database. `{ path?, journalMode?, synchronous?, busyTimeoutMs?, maxRows? }` — defaults `"WAL"` / `"NORMAL"` / `5000` / `10_000`. |
| `store.collection(name, schema, options?)` | Define/reopen a collection. `{ idField?, indexes?, enforceDefaults?, onParseError?, maxRows? }` — `enforceDefaults` defaults to `true`, `onParseError` to `"throw"`. |
| `collection.validate()` | List the stored rows the current schema rejects, as `{ id, error }`. Reads only. |
| `store.transaction(work)` | Run `work` in a single transaction — over **this store's connection only**. |
| `transactionAcross(stores, work)` | Run `work` in one transaction spanning several stores, over a connection that attaches each store's file. `work` receives one handle per store, positionally; only those handles are inside. Up to 11 file-backed stores, all in the same `journalMode`. Atomic commit needs a non-WAL one — see above. |
| `store.checkpoint(mode?)` | Run a WAL checkpoint — `"PASSIVE"` (default), `"FULL"`, `"RESTART"`, `"TRUNCATE"`. `TRUNCATE` reclaims the `-wal` sidecar. Returns `{ busy, log, checkpointed }`. |
| `store.database` | The underlying `bun:sqlite` `Database` (escape hatch). |
| `store.close()` | Close the connection. |
| `createCollection(database, name, schema, options?)` | Lower-level collection factory. |
| `populate(parents, foreignKey, target, as)` | Batched reference resolver. |
| `ref(prefix)` | Zod schema for a typed `prefix_…` reference. |
| `dateParser` | Zod schema for a timestamp that survives storage — accepts a `Date` or an ISO string, always yields a `Date`. |
| `compileWhere` / `compileOrderBy` / `compileLimitOffset` / `jsonExtract` | SQL-fragment helpers (advanced). `compileWhere` and `compileLimitOffset` return `{ sql, parameters }` — their values bind rather than interpolate, so concatenate the parameters in the order the fragments appear in the statement. `compileOrderBy` and `jsonExtract` return a `string`. |

## Development

You need [Bun](https://bun.sh). [mise](https://mise.jdx.dev/) is optional and
runs the same tasks CI does:

```bash
bun install
mise run typecheck        # bunx tsc --noEmit
mise run test             # bun test
mise run build            # bundle src/index.ts → dist/
mise run ci               # typecheck + test — the gate
```

Without mise, `bunx tsc --noEmit` and `bun test` are the same two steps. There is
also a Nix flake with a dev shell (`nix develop`) providing Bun and mise.

[`.github/workflows/check.yml`](.github/workflows/check.yml) runs `mise run ci` on
every pull request and every push to `main`. It calls that task rather than
re-spelling its steps, so the gate has one definition.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request, and
[`SECURITY.md`](SECURITY.md) for the private path to report a vulnerability —
not a public issue.

## Versioning

Semantic versioning, with every release recorded in
[`CHANGELOG.md`](CHANGELOG.md). Releases are published to npm as
`@binaryplease/zodstore`; the version in `package.json` is what a consumer pins
against and compares.

## License

MIT — see [`LICENSE`](LICENSE).
