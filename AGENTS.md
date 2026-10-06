# Commits

- Conventional commits: `type(scope): what the user gets`. The release notes are built from them, so `feat` and `fix` subjects are read by users: say what changed for them, not how.
- `feat` lands under Features, `fix` under Fixes. Anything else (`chore`, `refactor`, `test`, `docs`, `perf`) stays out of the notes.
- A breaking change ships a major: `feat(scope)!:` or a `BREAKING CHANGE: <what breaks>` line in the body. Only for real breaks (settings, data or workflows users relied on stop working), never to make a release look big.

# Releases

- Every push to `main` that touches the app publishes a release to users (`.github/workflows/release.yml`). Treat a push as a release.
- Patch: just push. The version comes from the latest `v*` tag and the bump is never committed, so `apps/desktop/package.json` lags behind on purpose. Don't "fix" it.
- Major: a breaking commit (above), then push. Nothing else to bump.
- Minor: `npm version --no-git-tag-version --prefix apps/desktop <x.y.0>`, commit `chore: release v<x.y.0>`, push. It must be higher than the latest tag.
- Preview the notes before pushing: `sh apps/desktop/scripts/release-notes.sh "$(git tag -l 'v*' --sort=-v:refname | head -1)..HEAD"`.
- Never push `v*` tags by hand; the workflow creates them. Details: `release` skill, `docs/releasing.md`.
