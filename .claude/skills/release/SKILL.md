---
name: release
description: Cut a Treeix release - every push to main ships a patch, a breaking commit ships a major, a package.json bump a minor; push, and watch GitHub Actions build and publish the DMG. Use on "cut a release", "ship a new version", "release 0.2.0", "publish a build", "/release".
---

# Cut a release

`.github/workflows/release.yml` ships a release on every push to `main` that touches the app (landing, docs,
marketing, `.claude` and markdown-only pushes are skipped). A patch needs nothing but the push. Your job is a
minor or major when asked, release notes users can read, and watching the run.

## Before pushing

1. Working tree clean and on `main`. If not, stop and say so.
2. `bun run typecheck && bun test` pass locally. The workflow runs both, so a failure here is a failed release, not a surprise.

## Release notes

The workflow writes them from the commits since the latest tag (`apps/desktop/scripts/release-notes.sh`): breaking
changes, then `feat` subjects, then `fix` subjects, scope first. Other types are left out. Preview before pushing,
and reword unpushed subjects that only make sense to us:

```sh
sh apps/desktop/scripts/release-notes.sh "$(git tag -l 'v*' --sort=-v:refname | head -1)..HEAD"
```

## Major

A commit since the latest tag marked breaking, `feat(scope)!: ...` or a `BREAKING CHANGE: ...` body line, makes the
workflow ship the next major (`1.4.2` -> `2.0.0`). Nothing to bump. Only for real breaks, and confirm with the user
first: there is no undoing a major once installed copies update into it.

## Minor

The workflow ships `apps/desktop/package.json` `version` as is when no tag has it yet; otherwise it releases the
patch after the latest tag (or the major, above). It never commits the bump, so `package.json` lags behind patch
releases on purpose.

```sh
# <version> is bare, e.g. 0.6.0
npm version --no-git-tag-version --prefix apps/desktop <version>
git commit -am "chore: release v<version>"
```

Ask before `git push`, every time:

```sh
git push origin main
```

The release creates the tag itself; never push a `v*` tag by hand, nothing listens for it.

## Watch the run

```sh
gh run watch --exit-status
gh release view v<version>
```

The release ends up with `Treeix-arm64.dmg` and the matching `.zip` attached. The landing page's `/download` redirect points at
`releases/latest/download/Treeix-arm64.dmg`, so it starts working the moment the release is published - no landing change needed.

## When it fails

- **Wrong version** - a tag was pushed by hand or a bump in `package.json` went backwards. Delete the stray tag (`git push origin :v<version>`) and push again.
- **`node-gyp` on the runner** - the native `mac-window` module needs Xcode command line tools; the `macos-14` image has them. A failure here is usually a dependency bump, not the runner.
- **Release already exists** - `gh release create` refuses to overwrite. Delete the release and the tag before retrying.

## Signing, notarisation and in-app updates

The workflow signs and notarises when `MAC_CERT_P12` and `APPLE_API_KEY_P8` are set, and publishes through
`electron-builder --publish always`, which is what uploads `latest-mac.yml`. That file is the update feed: without it,
or without a Developer ID signature, installed copies never move off their version. Setting the secrets up is
`apps/desktop/scripts/signing-secrets.sh`, described in `docs/releasing.md`.

Without those secrets the run falls back to the ad-hoc DMG, and first launch needs System Settings > Privacy &
Security > Open Anyway. Say so when reporting a release built that way, since those users have to update by hand.
