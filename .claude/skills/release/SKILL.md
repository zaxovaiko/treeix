---
name: release
description: Cut a Treeix release - bump the version, tag it, push, and watch GitHub Actions build and publish the DMG. Use on "cut a release", "ship a new version", "release 0.2.0", "publish a build", "/release".
---

# Cut a release

`.github/workflows/release.yml` builds and publishes on any `v*` tag. Your job is the bump, the tag, and watching the run.

## Before tagging

1. Working tree clean and on `main`, with `origin/main` already up to date. If not, stop and say so.
2. `bun run typecheck && bun test` pass locally. The workflow runs both, so a failure here is a failed release, not a surprise.

## Bump and tag

The tag must equal `apps/desktop/package.json` `version` with a `v` in front, or the workflow fails its first check on purpose.

```sh
# <version> is bare, e.g. 0.2.0
bun --print "1" >/dev/null                        # sanity: bun is on PATH
npm version --no-git-tag-version --prefix apps/desktop <version>
git commit -am "chore: release v<version>"
git tag v<version>
```

Ask before `git push`, every time, including the tag:

```sh
git push origin main
git push origin v<version>
```

## Watch the run

```sh
gh run watch --exit-status
gh release view v<version>
```

The release ends up with `Treeix-arm64.dmg` and the matching `.zip` attached. The landing page's `/download` redirect points at
`releases/latest/download/Treeix-arm64.dmg`, so it starts working the moment the release is published - no landing change needed.

## When it fails

- **Version mismatch** - the tag and `apps/desktop/package.json` disagree. Delete the tag (`git push origin :v<version>`), fix, tag again.
- **`node-gyp` on the runner** - the native `mac-window` module needs Xcode command line tools; the `macos-14` image has them. A failure here is usually a dependency bump, not the runner.
- **Release already exists** - `gh release create` refuses to overwrite. Delete the release and the tag before retrying.

## Signing, notarisation and in-app updates

The workflow signs and notarises when `MAC_CERT_P12` and `APPLE_API_KEY_P8` are set, and publishes through
`electron-builder --publish always`, which is what uploads `latest-mac.yml`. That file is the update feed: without it,
or without a Developer ID signature, installed copies never move off their version. Setting the secrets up is
`apps/desktop/scripts/signing-secrets.sh`, described in `docs/releasing.md`.

Without those secrets the run falls back to the ad-hoc DMG, and first launch needs System Settings > Privacy &
Security > Open Anyway. Say so when reporting a release built that way, since those users have to update by hand.
