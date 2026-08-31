# Changelog

Notable changes to `zodstore`, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

A version here is what a consumer pins and compares against: before `0.1.0` there
was nothing to name, so "which docstore is this?" could only be answered by
diffing trees (F008). Releases from `0.4.0` on are published to npm.

## 0.4.1 — 2026-08-27

### Changed

- **The published tarball is now an allowlist.** `package.json` declares
  `files: ["src", "README.md", "CHANGELOG.md", "LICENSE"]`, so an install brings
  the library, its documentation and its licence and nothing else — the test
  suite, the CI workflow, the flake, `tsconfig.json` and the ignore files no
  longer ship. Nothing exported changes and no consumer loses anything it could
  import.

  The reason is the direction the control fails in. npm packs the *working
  directory*, not git, so the only thing deciding a tarball used to be an
  `.npmignore` denylist keyed to names and suffixes — and a denylist fails open
  on whatever nobody thought to name. That list reached `server.env` and a stray
  `-wal` sidecar; it did not reach `id_rsa`, `.envrc`, `.netrc` or
  `.git-credentials`, all of which a real `npm pack` shipped. An allowlist fails
  closed instead, and a registry version is never taken back. `.npmignore` stays
  as a second layer (F052).

### Fixed

- **A stored row that fails the schema no longer reports its own content.** The
  read path withheld the JSON parser's message but forwarded a `ZodError`'s
  verbatim, on the premise — stated in the code, in the `0.2.0` entry below, and
  never measured — that a `ZodError` names paths and types and carries no
  values. It does not. Its `message` is the serialised issue list, an issue's
  `path` runs through a `z.record()`'s keys, and under Zod 3 the issue carries
  the rejected value as `received`. A row of valid JSON that merely fails the
  *current* schema — ordinary schema drift, on `onParseError: "throw"`, the
  default — therefore put document content into the exception thrown by `get()`,
  `find()`, `findByIds()` and `findOne()`, and from there into a log (F028).

  The issue list is now rendered rather than forwarded: each issue reads
  `"consents.<key>" (invalid_type, expected boolean)` — the path, the `code`,
  and `expected` where it is a string. A path segment is printed when the schema
  declares it and elided as `<key>` when it does not, which is the rule the
  write gate has always applied to a record's keys; an array index is printed,
  because a position is not content. The `ZodError` remains the `cause`, so a
  caller that deliberately inspects it loses nothing.

  Message text only: what is thrown, when it is thrown, and what `validate()`
  returns are all unchanged.
- **The write gate's round-trip refusal, by the same reflex and the same
  remedy.** `serializeDocument` interpolated a `ZodError`'s message into the
  refusal it raises for a document whose stored form its own schema rejects —
  immediately above a second refusal that goes to great length to print paths
  and never values. It renders the issue list through the same renderer now, and
  says so in the same words its neighbour does.

### Note

`zod3` — the older declared peer major, aliased — is a devDependency now, so the
suite proves both ends of the `^3.24.0 || ^4.3` peer range rather than only the
one this repository develops against. The peer range itself is unchanged, and a
consumer installs neither.

## 0.4.0 — 2026-08-27

The package is named `zodstore` and is publishable. No behaviour changed — every
export, option and default is exactly what `0.3.2` shipped.

### Changed

- **The package is `zodstore`.** That is the specifier every consumer imports,
  and the rename from the pre-release name is a breaking change for anyone on
  `0.3.x` — the whole reason this is a minor bump rather than a patch. The name locks
  Zod — the single source of truth this library is built on — and leaves the
  storage backend unnamed, because that is a targeting decision rather than the
  identity. `DocStore`, the exported type, keeps its name: it is a document-store
  handle, and renaming it would break the API for nothing.
- **`package.json` is publishable.** `private: true` is removed — it blocks
  `npm publish` while leaving `npm pack` working, so it fails at the one step
  that cannot be retried. Added alongside it: `author`, `homepage`, `repository`,
  `bugs`, `keywords` and an `engines.bun` floor, which are what a registry page
  and a consumer's tooling read.
- **`README.md` install section** names the package, installs it beside its Zod
  peer, and says out loud that the published artifact is TypeScript source rather
  than a bundle — `exports` points at `src/index.ts`. That is right for a
  Bun-only library and unusual enough on npm to be worth stating.
- **The versioning note** no longer says the package is private and unpublished.

### Fixed

- **The published tarball is the library, not the working tree.** npm packs from
  the working tree rather than from git, and falls back to `.gitignore` when no
  `.npmignore` exists. Removing `private: true` turned a directory that could not
  be published into one that could, with nothing in between. The `.npmignore`
  added here is that something, and it ships with the package rather than staying
  behind — because the patterns that matter are the ones about files that are
  never committed at all: an environment file that is not dot-prefixed, a key, a
  `-wal` sidecar left by a test run. A clean git history is silent about every one
  of them, and a registry never takes a version back.

## 0.3.2 — 2026-08-27

The files a public repository needs, and a task set that works in one. Nothing a
caller runs changed.

### Added

- **`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` and `SECURITY.md`**, plus issue and
  pull-request templates under `.github/`. `CONTRIBUTING.md` states the
  contribution terms: **no contributor licence agreement and no sign-off** —
  opening a pull request offers the change under the same MIT licence the
  project is released under, which is the ordinary inbound-matches-outbound
  convention. `SECURITY.md` names GitHub's private vulnerability reporting as
  the reporting path, describes what is in scope, and says plainly what is not —
  documents are stored as plaintext JSON, and encryption at rest belongs above
  this library or in the filesystem underneath it.

### Changed

- **The task set is split by where it travels.** `.mise.toml` now holds
  `typecheck`, `test`, `build`, `lint` and `ci` — everything that needs nothing
  but a checkout and the pinned toolchain. The tasks that operate on material
  which does not ship moved to `mise.local.toml`, which mise merges into the
  same config, so `mise run check` and `mise run findings:index` behave exactly
  as before and `mise tasks ls` still shows all eight.

  The reason is that `.mise.toml` is one of the files that would travel to a
  published copy of this library, and two of its tasks operated on a directory
  that would not — so a published checkout would document commands that fail.
  `.github/workflows/check.yml` travels for the same reason and now reads as a
  gate on its own terms.
- **`README.md`'s Development section documents the tasks that will exist**, and
  leads with `bun install` and the plain `bunx tsc --noEmit` / `bun test` pair
  for anyone without mise. It links `CONTRIBUTING.md` and `SECURITY.md` instead
  of anything that does not ship.
- **The changelog's finding references are plain ids, not links.** Thirty-three
  Markdown links pointed at files that do not ship — resolvable while they sat
  beside them, so nothing flagged them, and dead in a published copy. The ids
  stay as opaque references; only the links are gone.

### Fixed

- **The confidentiality guard now catches a link that stays behind.** It already
  refused a link escaping the repository root; it now also refuses one that
  resolves *inside* the repository but outside the set of files that travel —
  which is what the thirty-three changelog links were. It also asserts that the
  readiness surface above is in that set, since a file is only published if it
  travels.

## 0.3.1 — 2026-08-27

The licence, and nothing a caller runs.

### Changed

- **Licensed MIT.** `LICENSE` is the standard MIT text, `Copyright (c) 2026
  Enrico Scherlies`, and `package.json`'s `license` field is `"MIT"` — it was
  `"UNLICENSED"` beside a `LICENSE` that read "proprietary and confidential" and
  granted no permission to anyone. Anyone holding a copy of this library may now
  use, modify and redistribute it under those terms.

  `"private": true` is unchanged and deliberate: the source is licensed openly,
  but nothing is published to a registry yet, and `private` is what keeps that
  from happening by accident. Consumers still vendor the library or depend on it
  by path, and still pin against the version here.

  The paragraph the old licence carried about vendoring a copy into another
  project is gone rather than reworded. MIT grants that permission to everyone,
  so it no longer needs to live in the legal text.
- **Comments and documentation no longer cite documents a reader cannot open.**
  Every rule that was cited by a document number is now stated in plain words at
  the place it was cited, including the message
  `store.collection(...)` throws for a field with no `.default(...)` — which
  names the rule and the `{ enforceDefaults: false }` opt-out instead of a
  document number. The diagnosis each message carries is unchanged, and so is
  every behaviour: this is comment, prose and licence text only.

  The worked examples changed with them. The cross-store transaction example — in
  the README, in `transactionAcross`'s doc comment and in the test suite — now
  spans an `orders` and an `inventory` store rather than the two files a
  particular deployment happened to have, because an example that reproduces one
  reader's architecture is not a neutral example. Same API, same assertions.
- **A guard in the suite keeps it that way.** The test suite now reads every file
  that would travel to a published copy — `src/`, `test/`, `README.md`,
  `CHANGELOG.md`, `LICENSE`, `package.json`, `tsconfig.json`, `flake.nix`,
  `.gitignore`, directories walked recursively — and fails if that vocabulary
  reappears, or if `LICENSE`, `package.json` and the README's licence statement
  stop agreeing.

## 0.3.0 — 2026-08-18

### Added

- **`transactionAcross(stores, work)` — one transaction over several stores.**
  `store.transaction` covers the connection it was called on and no other, so a
  callback that also wrote through a collection of a *different* store was only
  half inside a transaction: the other write committed on its own statement, and
  a throw rolled back one half while leaving the other behind. No ordering of the
  two writes made the pair atomic
  (F035).
  `transactionAcross` attaches every store's file to a connection of its own and
  runs the work there under `BEGIN IMMEDIATE`, so a throw rolls every file back
  and a return commits every file.

  The callback receives one `AttachedStore` handle per store, in the order the
  stores were given, and **only those handles are inside the transaction** — a
  collection opened on an outer store object still writes on that store's own
  connection, though it can no longer do so quietly: the transaction holds the
  write lock on every file it spans, so such a write waits out its
  `busyTimeoutMs` and then throws `database is locked`.

  **The limit is part of the feature, not a footnote.** SQLite commits attached
  databases atomically *only when the journal mode is not WAL*
  (`sqlite.org/lang_attach.html`), and `"WAL"` is this library's default. Under
  WAL the **error path is closed** — a throw rolls both files back — while the
  **crash window between the two file commits is not**. Order the writes so that
  window fails in the direction you can live with, or open the stores with a
  non-WAL `journalMode`, where the multi-file commit is atomic outright. The
  README states this where it announces the guarantee.

  Everything it refuses, all before anything is opened: an empty list; a store
  `createStore` did not open; an in-memory store in any position, because
  `ATTACH ':memory:'` opens a second, empty database rather than reaching the
  store's and every write would land there; the same file twice, symlinks
  resolved; more than 11 stores, because `SQLITE_LIMIT_ATTACHED` is 10 and one
  store is the connection's own; and a set whose `journalMode`s disagree — an
  attached database keeps the mode its own header says, and the weakest member
  decides the commit, so a mixed set would hand WAL's guarantee to a caller who
  had taken the non-WAL escape hatch above.

  `busy_timeout` is a per-connection pragma and the transaction runs on a
  connection of its own, so a set of stores with differing `busyTimeoutMs` is
  governed by `stores[0]`'s.

- **`AttachedStore`** — the handle type `transactionAcross` hands its callback.
  `collection(name, schema, options?)` only: a transaction is already running,
  and the connection under it belongs to `transactionAcross`.

### Changed

- Nothing a caller sees. Internally, collection statements are now
  schema-qualified (`"main"."users"` rather than `"users"`), which is what lets
  one connection address several attached files without their tables colliding,
  and the reopen binding that pins `idField` is keyed per database as well as per
  table name. That registry hangs off the connection, and `transactionAcross`
  opens one per call, so it also carries each store's bindings onto that
  connection before handing out handles and back onto the store's after a commit
  — without which the `idField` guard would be unreachable on this path, and a
  handle could reopen a collection under an identity convention the store itself
  refuses. The per-connection registry is otherwise unchanged: a second
  `createStore` on the same file still starts with an empty one (F018).

## 0.2.0 — 2026-08-14

Two ways an absent value changed a statement's meaning, closed together because
they are one confusion with two answers: the query compiler read `undefined` as
"no-op", the write path read it as "assign", and each file had taken the reading
that is unsafe in its own context.

A minor bump rather than a patch, and rather than folding these into `0.1.0`:
`0.1.0` is already vendored downstream, both changes alter what existing
code does, and one version number naming two materially different trees is the
condition F008 exists to
prevent.

It also carries the non-blocking follow-ups the branch's land review left behind,
below the two above.

### Changed

- **`compileLimitOffset` returns a `CompiledClause`, not a `string` — breaking
  for a direct caller.** It now hands back `{ sql, parameters }` like
  `compileWhere` already did, because the page bounds are bound rather than
  interpolated. The library's own callers are updated; the export is part of the
  public surface, so a consumer that composes SQL through it appends
  `pageClause.sql` and concatenates `pageClause.parameters` after the
  where-clause's own — they bind by position, and `WHERE` precedes `LIMIT` in the
  statement. `compileWhere`, `compileOrderBy` and `jsonExtract` are unchanged
  (F024).

### Fixed

- **An absent value narrows a `where` instead of widening it — breaking.** A
  condition whose value is `undefined` now compiles to a clause matching no row.
  It was *skipped*, so a filter built from state that had not loaded yet lost the
  condition it was written to apply, and a `where` that lost every condition
  compiled to no clause at all — `deleteMany({ ownerId })` with an undefined
  `ownerId` emitted a bare `DELETE FROM` and emptied the collection, while
  `count` and `find` answered over every row
  (F022).
  The rule now holds wherever the value goes missing: in an operator object
  (`{ age: { gte: undefined } }`) and beside a live sibling (`{ status: "open",
  assignee: undefined }` matches nothing rather than every open case).
  A disjunction with one live alternative is unaffected in positive position —
  `OR: [{ assignee: undefined }, { assignee: null }]` still returns the
  unassigned rows, as documented. To mean "no filter", omit `where` or pass `{}`;
  only a clause naming no key matches everything, which is what keeps
  `deleteMany({})` meaningful. **Migration:** a call relying on an `undefined`
  condition to drop out now returns nothing instead of everything — build the key
  conditionally (`...(assignee !== undefined && { assignee })`) where the filter
  is genuinely optional.
- **A gap can no longer be negated into a match — breaking.** A clause carrying a
  missing value anywhere below it compiles to "no rows" under `NOT` rather than
  being negated, at any depth. `NOT` flips polarity, so a disjunction that a
  missing branch *narrowed* produced a correspondingly *wider* complement:
  `deleteMany({ NOT: { OR: [{ assignee: currentUser }, { assignee: null }] } })`
  with an unset `currentUser` deleted every row except the unassigned ones,
  including the rows the missing condition existed to protect. That is the
  "delete everything except these" retention shape and the one the README teaches
  for `NOT`. A disjunction is now allowed to be a usable filter and unsafe to
  negate at the same time, which is the truth about it
  (F022).
  An *explicit* `OR: []` decided "no rows" with nothing missing, so
  `NOT: { OR: [] }` still matches every row. **Migration:** as above — a negated
  filter built from optional state now matches nothing rather than too much.
- **`update()` no longer resets a field to its default — breaking.** A patch key
  holding `undefined` is "not supplied" and leaves the stored value alone. It was
  spread in, so `JSON.stringify` dropped the key and the `.default(...)` every
  non-identity field is required to declare refilled it — replacing a stored
  value with no error, no log and no trace, on `update(id, { title: form.title })`
  with an optional `form.title`
  (F023).
  Clearing a field now means naming the value to clear it to (`{ note: null }`,
  or the empty value the schema takes). The rule covers `ref()` foreign keys too:
  an `undefined` there previously failed the parse loudly — `ref()` carries no
  default — and is now a no-op that keeps the stored reference, so one rule holds
  for every field. `replace()` is unchanged: it is a whole new document, so a
  field omitted there still takes its default; under `{ enforceDefaults: false }`
  it is also the only way to clear a field that declares no default, since such a
  field rests at `undefined` and `update()` has no value left to name.
  **Migration:** a call that relied on `undefined` to reset a field must pass that
  field's value explicitly.

- **A `Date` operand in a typed `where` now works instead of throwing.** The
  typed surface types a `dateParser` field's conditions as `Date`, but
  `toSqlParameter` rejected `Date` operands — so a type-correct comparison like
  `{ at: { gt: new Date(…) } }` compiled at the type level and threw
  `Unsupported filter value` at runtime, and the ISO-string spelling was a type
  error, leaving `dateParser` fields queryable neither way
  (F029).
  A `Date` now binds as `toISOString()` — the exact form `JSON.stringify`
  stores, so every operator and `orderBy` compare chronologically. An invalid
  `Date` is refused naming the operator or field at fault (`Invalid Date
  operand for operator "gt": …`) rather than surfacing as `toISOString()`'s
  opaque `RangeError`. The lexicographic premise is enforced, not assumed: a
  date outside years 0000–9999 stores in the expanded ISO form (`+275760-…`),
  which sorts before every in-range value — `dateParser` now refuses to store
  one and the compiler refuses one as an operand, so a far-future sentinel can
  no longer be silently deleted by a retention filter it should survive.
- **A paged read no longer retains a prepared statement per page.** The `LIMIT`
  and `OFFSET` bounds are bound rather than inlined, so every page of a query
  shares one cached statement. Inlined, each distinct `limit`/`offset` was a
  distinct SQL string and `bun:sqlite` caches a prepared statement per string for
  the life of the connection with no eviction — measured at ~56 MB retained
  across 20k pages of a five-row collection, unbounded, driven by a value an HTTP
  list endpoint normally forwards from its query string, and accumulating once
  per open `Database`
  (F024).
  No behavioural change to what a page returns.
- **Row bounds are validated as *safe* integers.** `limit`, `offset` and
  `maxRows` were checked with `Number.isInteger`, which is `true` for `1e21` — a
  number that no longer denotes one particular integer, and which reached the SQL
  text as the literal `LIMIT 1e+21`. They now use `Number.isSafeInteger`, and
  `maxRows` is additionally refused at `Number.MAX_SAFE_INTEGER` rather than
  below it, because `find()` compiles its ceiling as `maxRows + 1` and that sum
  has to stay representable — otherwise a ceiling accepted at the store's edge
  fails later in the query compiler, which is the wrong edge to report
  (F025). The
  `Invalid maxRows` message now names the upper bound as well as the lower.
- **A malformed row reports its position, not its contents.** The read path
  appended the JSON driver's own message, and JavaScriptCore quotes the token it
  failed on — so a row corrupted to hold a bare identifier reproduced that
  fragment of the stored document into the exception and from there into a log,
  which is the leak the write gate was hardened against, one surface along
  (F021).
  `get()` and `update()` on such a row now say `Malformed JSON at line 1, column
  12 — the parser's own message is withheld…`, still naming the collection and
  the row id. The original `SyntaxError` remains the `cause`, so a caller that
  deliberately inspects it loses nothing. **This covers the `JSON.parse` half
  only.** A row that fails *Zod* still has its `ZodError` message forwarded
  verbatim, and that message does reach stored content — a `z.record()`'s keys on
  both peer majors, and the rejected value itself under Zod 3. An earlier
  revision of this entry described that branch as carrying no values; it does,
  the gap is tracked as
  F028,
  and it is unchanged in this version.

One public type changed — `compileLimitOffset`, above. The absence tracking the
`NOT` guard needs is internal to `src/query.ts`, and `compileWhere`,
`compileOrderBy` and `jsonExtract` still have the signatures they shipped with.

## 0.1.0 — 2026-08-13

The first version worth pinning. Everything below already existed in the working
tree at some point; nothing was ever recorded against a version number, so this
entry is the whole shipped surface rather than a diff against a predecessor.

### Added

- **The store and collection surface.** `createStore` / `createCollection`
  (factory functions, not classes) over one `bun:sqlite` database; one fixed
  `(id TEXT PRIMARY KEY, doc TEXT NOT NULL)` table per collection with Zod
  validating every write and re-parsing every read; `json_extract`
  expression indexes; `get` / `find` / `findOne` / `count` / `insert` /
  `insertMany` / `update` / `replace` / `upsert` / `delete` / `deleteMany`;
  `store.transaction(work)`.
- **Batched joins.** `findByIds` (one `IN` query, deduped, order-preserving),
  `populate(parents, foreignKey, target, as)` — which emits an explicit `null`
  for a missing reference rather than dropping the key — and `ref`
  for typed `prefix_…` foreign keys.
- **`store.checkpoint(mode?)`.** Runs `PRAGMA wal_checkpoint` in `PASSIVE`,
  `FULL`, `RESTART`, or `TRUNCATE` mode; `TRUNCATE` is what reclaims a `-wal`
  sidecar that has grown to its high-water mark. Shipped with tests but recorded
  nowhere and absent from the README until now
  (F016).
- **`dateParser`.** A timestamp that survives storage — accepts a `Date` or an
  ISO string, always yields a `Date`
  (F003).
- **`collection.validate()`** and the **`onParseError`** policy (`"throw"` |
  `"skip"`), so one unparseable row is a listed id to act on rather than a
  broken collection
  (F006).
  Under `"skip"`, `findOne()` streams to the first *readable* match instead of
  taking `LIMIT 1` and filtering it away, so it no longer answers `null` while
  readable matches exist. `find({ limit })` still pages over rows before the
  skip applies and can return a short page — deliberate, and documented under
  `onParseError` in the README.
- **A result ceiling.** `maxRows` on the store and per collection, default
  `10_000` (`DEFAULT_MAX_ROWS`), `null` to disable. An unbounded `find()` throws
  rather than truncating — a silently truncated result is a wrong answer
  (F010).
- **Dotted field paths** in `where`, `orderBy`, and `indexes`, typed to three
  levels (F011), and
  the **`OR` / `NOT` combinators**, which nest and page as one query
  (F012).
- **Per-pragma store options** — `journalMode`, `synchronous`, `busyTimeoutMs` —
  each validated through a closed lookup map before the database is opened
  (F014).
  `busyTimeoutMs` accepts an integer in `0…2147483647`: above that SQLite's
  PRAGMA parser yields `0`, turning a request for a longer wait into no wait at
  all, so it is refused rather than applied.
- **The `enforceDefaults` gate.** `store.collection(...)` walks an object schema
  once and refuses a non-identity field with no `.default(...)`, naming it, so
  the default rule is enforced rather than documented. `{ enforceDefaults: false }` is
  the deliberate exception
  (F015).
  It defaults to `true`, so it is **breaking for an existing schema**: an optional
  field with no default now throws at `store.collection(...)`, including
  `ref("user").optional()` (the identity exemption rides on the object `ref()`
  returns, so a wrapper drops it — write `ref("user").nullable().default(null)`).
  The walk is one level deep; a nested object's members are not checked.
- **Repository hygiene.** A work-tracking register, this changelog, a `LICENSE`
  matching the README's licence claim, and a GitHub Actions gate running this
  repo's own mise task (F008).

### Changed

- **`zod` peer range widened to `^3.24.0 || ^4.3`** so the consumer owns the Zod
  version. It stays a peer dependency: two Zod copies in one process is a class
  of bug this library must never cause.
- **Writes are gated on a round trip.** A document is storable only if its
  stored JSON passes its own schema *and* re-parses to itself, so a schema whose
  parse rewrites an already-parsed value is rejected at the write rather than
  drifting on every read
  (F002,
  F003).
  "Re-parses to itself" is compared structurally, by type as well as by value, so
  a `Date` under `z.record(…, z.unknown())` or a union with a string branch — a
  value whose stored bytes are a fixed point while the value read back is a
  `String` — is refused too. The refusal names the offending **field paths** and
  never the values at them, so an uncaught throw cannot put document content into
  a log. A rejected id is reported the same way — by type ("got a number"), not
  by value, and the message now names the collection it came from.
- **Default pragmas are now `journal_mode=WAL`, `synchronous=NORMAL`,
  `busy_timeout=5000`.** `synchronous` was `FULL`, which cost roughly two orders
  of magnitude of write throughput against the benchmark that justified the
  design (F001);
  `busy_timeout` was `0`, so the second writer threw `database is locked`
  immediately (F004).

### Fixed

- **`update` is atomic.** The read-merge-write runs inside `BEGIN IMMEDIATE` and
  merges into the *stored* document rather than the parsed result of a read, so
  a racing connection waits out its `busyTimeoutMs` and fails loudly instead of
  having its committed change silently overwritten. `replace` takes the write
  lock the same way
  (F005).
- **`contains` / `startsWith` / `endsWith` escape their operand.** `%` and `_`
  are ordinary characters in names and paths; a search box that turned `%` into
  a full-collection scan was a cheap way to make a server unresponsive. `like`
  remains the raw escape hatch and compiles with `ESCAPE '\'`
  (F009). Because `\` is
  now the escape character, a literal backslash in a raw `like` pattern must be
  doubled; it fails closed (matching fewer rows, never more).
- **Every bad operand names itself.** `in` / `notIn` handed a non-array used to
  die as `values.map is not a function` from inside the compiler; they now throw
  naming the operator and the type they got, as `contains` / `startsWith` /
  `endsWith` already did, and `null` reads as `null` rather than as
  `typeof null` (F019).
  No compiled SQL changes for a valid operand.
- **A conflicting reopen throws.** Reopening a collection may extend the schema
  and add indexes, but may not change `idField` — identity is what the stored
  rows are keyed by, so two conventions can no longer be written into one table
  (F013).
  The binding is keyed case-insensitively, because SQLite identifiers are:
  `collection("KS")` and `collection("ks")` are one table and now one binding.
  The check holds within a connection only — a second connection to the same
  file starts empty
  (F018).

### Removed

- **`applyDefaultPragmas`** — breaking. One boolean covered both pragmas, and one
  of them (`PRAGMA foreign_keys`) was a no-op here: documents are JSON blobs and
  no `REFERENCES` clause is ever emitted, so the flag's only real effect was
  turning WAL off, which is never what a caller wants. Replaced by the
  `journalMode` / `synchronous` / `busyTimeoutMs` options above; `PRAGMA
  foreign_keys` is gone entirely, with the reason recorded in a comment in
  `src/store.ts`. No deprecated alias is carried — the package was at `0.0.0`
  with a single vendored consumer
  (F014).
