# Contributing

Thanks for looking. This is a small library with a narrow purpose, and the
fastest way to get a change merged is to know what it is trying to be.

## What this library is

A document store built on `bun:sqlite` and Zod, for Bun only. Zod is the
gatekeeper: every document is validated on the way in and re-parsed on the way
out. SQLite is the engine: one table per collection, documents stored as JSON,
queries compiled to `json_extract` with bound parameters.

Three constraints shape almost every review comment, so they are worth knowing
before you write code rather than after:

- **Bun only.** The library imports `bun:sqlite`. There is no Node compatibility
  path and a pull request adding one will be declined — that is a different
  library, not a feature of this one.
- **Zod stays a peer dependency.** The consumer owns the Zod version. Two copies
  of Zod in one process is a class of bug this library must never cause, so Zod
  is never a hard dependency here. The suite is the one place two copies live on
  purpose: the older declared major is a devDependency under the `zod3` alias, so
  the message guards run against both ends of the peer range. A test schema is
  built from one major or the other and never mixes the two — `ref()` and
  `dateParser` come from the copy the library itself resolves.
- **No SQL identifier ever comes from caller data.** Collection names, id fields
  and field paths are validated against strict patterns; values always travel as
  bound parameters; PRAGMA arguments come from closed lookup maps, because they
  cannot be bound. The test suite has an injection guard, and it stays passing.

There are no migrations, by design. Every non-identity field declares a
`.default(...)`, which is what lets an old row read forward under an extended
schema. Identity fields — the id field and `ref()` foreign keys — carry no
default and fail loudly. A pull request that adds a field without a default is
asking for that rule to be relaxed, so say so explicitly and explain why.

## Getting set up

You need [Bun](https://bun.sh). [mise](https://mise.jdx.dev/) is optional but
runs the same tasks CI does.

```bash
bun install
mise run ci        # type-check and the full suite — the gate
```

Without mise, `bunx tsc --noEmit` and `bun test` are the same two steps.

There is also a Nix flake with a dev shell (`nix develop`) that provides Bun and
mise, if that is how you prefer to get a toolchain.

## Making a change

- **Every behaviour change carries a test.** The suite is one file,
  `test/docstore.test.ts`, and it is long on purpose — a defect without a
  regression test comes back. Add yours next to the tests for the same area.
- **`mise run ci` must be green** before you open the pull request. CI runs
  exactly that task, so a green run locally is a green run there.
- **A user-visible change goes in `CHANGELOG.md`**, in the same change that makes
  it — anything exported from `src/index.ts`, any default, any option. The
  format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions
  follow [semantic versioning](https://semver.org/spec/v2.0.0.html).
- **Names are descriptive.** No single letters, no invented acronyms. The
  codebase is consistent about this and review holds the line.
- **Factory functions, not classes** — `createStore`, `createCollection`. Keep it
  that way.

Small, focused pull requests get reviewed faster than large ones. If you are
planning something big, open an issue first and describe it — it is cheaper for
both of us to disagree about the design before you have written it.

## Contribution terms

**There is no contributor licence agreement and no sign-off requirement.** By
opening a pull request you are offering your contribution under the same
[MIT licence](LICENSE) the project is released under — inbound matches outbound,
which is the ordinary convention for MIT projects on GitHub.

Two things follow, and they are the reason this section exists at all:

- Contribute only code you have the right to contribute. If your employer owns
  what you write, you need their agreement before you send it here.
- Do not paste in code from another project unless its licence permits it *and*
  you say where it came from in the pull request. Attribution that arrives after
  a merge is a problem for everyone downstream, because a licence claim is
  something users rely on without checking.

## Reporting bugs and asking for features

Use the issue templates — they ask for the Bun version, the Zod version, and a
minimal reproduction, which are the three things a report is usually missing.

**Do not open a public issue for a security vulnerability.** See
[SECURITY.md](SECURITY.md) for the private reporting path.

## Code of conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
