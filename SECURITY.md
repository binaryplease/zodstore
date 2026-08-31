# Security policy

## Reporting a vulnerability

**Please do not open a public issue.** Report it privately through GitHub's
private vulnerability reporting, from this repository's **Security** tab →
*Report a vulnerability*. That opens a private thread visible only to the
maintainers, and it is the path this project prefers.

**If that form is not there** — you have no GitHub account, or the Security tab
offers no *Report a vulnerability* option — then do not describe the problem in
public, **not even in general terms**. Open an issue containing only a request
for a private contact: no product area, no version, no hint of the mechanism. A
maintainer will reply with somewhere private to send the details. A public issue
naming an unfixed flaw is a signpost to it, which is the one outcome this policy
exists to avoid.

If the form is missing, please say so in that issue as well. It is meant to be
enabled, and its absence is a fault in this project's setup that gets fixed
before anything else.

What helps, in rough order of usefulness:

- the version or commit you are looking at, and the Bun and Zod versions;
- a minimal reproduction — the schema, the call, and what happens;
- what an attacker gets out of it, which is often the part a report leaves
  implicit.

You will get an acknowledgement that the report was received and read. This is a
small project maintained in spare time, so please do not expect same-day triage.
If you plan to disclose publicly, say so and give a timeframe, and it will be
worked to.

## Supported versions

The latest release is the only supported version. There are no maintained
release branches and no backports — fixes land on `main` and go out in the next
version.

## What is in scope

This is a library, not a service, so the interesting boundary is what a caller
can do to the process embedding it.

In scope, and taken seriously:

- **SQL injection through any input the library accepts.** Collection names, id
  fields, field paths, `where` clauses, `orderBy`, and limit and offset values.
  No SQL identifier is ever built from caller data, and every value binds as a
  parameter — a way around either of those is a vulnerability, not a bug report.
- **A crafted schema or query that reaches SQL it should not**, including via
  Zod wrappers, transforms, or nested field paths.
- **Error messages that disclose stored document content.** Diagnostics name
  fields and paths; they must not echo values, because the values are the
  caller's data and are frequently personal data.
- **A way to read or write rows outside the collection a call names.**

Out of scope, because they are properties of how you deploy it rather than of
this code:

- **Documents are stored as plaintext JSON.** The library does not encrypt at
  rest. If your documents need encryption, that belongs above this library or in
  the filesystem underneath it. This is a design decision, documented in the
  README, not an oversight.
- **File permissions on the SQLite database.** The library opens the path it is
  given; who can read that file is your operating system's question.
- **Denial of service by a caller of your own application** — an unbounded query
  against a large collection is slow, and the result ceiling exists to help you
  bound it. A caller you already trust with arbitrary queries is not a boundary
  this library defends.
- **Vulnerabilities in Bun or SQLite themselves.** Report those upstream; if the
  library can work around one, that is worth an issue here too.

## What happens to a report

A valid report gets a fix on `main`, a regression test in the suite, a release,
and a security advisory naming the affected versions. You will be credited
unless you would rather not be — say which you prefer in the report.
