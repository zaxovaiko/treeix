# Releases

- Every push to `main` that touches the app publishes a patch release to users (`.github/workflows/release.yml`). Treat a push as a release.
- Patch: just push. The version comes from the latest `v*` tag and the bump is never committed, so `apps/desktop/package.json` lags behind on purpose. Don't "fix" it.
- Minor or major: `npm version --no-git-tag-version --prefix apps/desktop <x.y.0>`, commit `chore: release v<x.y.0>`, push. It must be higher than the latest tag.
- Never push `v*` tags by hand; the workflow creates them. Details: `release` skill, `docs/releasing.md`.
