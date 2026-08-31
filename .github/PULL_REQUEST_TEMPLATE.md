<!--
Thanks for the pull request. There is no CLA and no sign-off to add — opening
this offers the change under the project's MIT licence. See CONTRIBUTING.md.
-->

## What this changes

<!-- One or two sentences. If it fixes an issue, "Fixes #123" here. -->

## Why

<!--
The problem, not the diff. A reviewer who understands what you were trying to
do can suggest a better route; one reading only the change cannot.
-->

## Checklist

- [ ] `mise run ci` is green (or `bunx tsc --noEmit` and `bun test`)
- [ ] A behaviour change carries a test in `test/docstore.test.ts`
- [ ] A user-visible change — anything exported from `src/index.ts`, any default,
      any option — is recorded in `CHANGELOG.md`
- [ ] Any new non-identity schema field declares a `.default(...)`, or the change
      explains why the forward-compatibility rule should be relaxed here
- [ ] No SQL identifier is built from caller data; values bind as parameters

## Anything you are unsure about

<!--
Optional, and genuinely useful. A named uncertainty gets looked at; an unnamed
one gets discovered later.
-->
