---
name: release
description: Cut a Treeix release - every push to main ships a patch, a breaking commit ships a major, a package.json bump a minor; push, and watch GitHub Actions build and publish the DMG and AppImage. Use on "cut a release", "ship a new version", "release 0.2.0", "publish a build", "/release".
---

# Cut a release

`.github/workflows/release.yml` ships a release on every push to `main` that touches the app (`apps/desktop`,
`crates`, `Cargo.*`, `rust-toolchain.toml`; markdown-only pushes are skipped). A patch needs nothing but the push. Your job is a
minor or major when asked, release notes users can read, and watching the run.

## Before pushing

1. Working tree clean and on `main`. If not, stop and say so.
2. `cargo test --workspace` and, in `apps/desktop`, `bun run typecheck && bun test src` pass locally. The release
   builds without running tests, so a failure here ships unless CI catches it first.

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

The workflow ships `apps/desktop/package.json` `version` as is when it is above the latest tag; otherwise it releases the
patch after the latest tag (or the major, above). `tauri.conf.json` reads its version from that file. The workflow
never commits the bump, so `package.json` lags behind patch releases on purpose.

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

The release stays a draft until the Mac and Linux jobs are done, then gets `latest.json` and goes public. It carries
`Treeix.dmg` (universal), `Treeix.app.tar.gz`, `Treeix-x86_64.AppImage`, their `.sig` files and `latest.json`. The
landing page's `/download` redirect points at `releases/latest/download/Treeix.dmg`, so it starts working the moment
the release is published - no landing change needed.

## When it fails

- **Wrong version** - a tag was pushed by hand. Delete the stray tag (`git push origin :v<version>`) and push again.
- **Missing private key** - `tauri build` stops with "A public key has been found, but no private key": the `TAURI_SIGNING_PRIVATE_KEY` secret is missing.
- **Notarization rejected** - `xcrun notarytool log <id> --key ... --key-id ... --issuer ...` says which binary; usually a sidecar without the hardened runtime or a timestamp.
- **A job failed after the draft opened** - re-run the failed jobs; uploads use `--clobber` and the draft is reused. A draft left behind by an abandoned run can be deleted with `gh release delete v<version>`.

## Signing, notarisation and in-app updates

The Mac job needs `MAC_CERT_P12`, `MAC_CERT_PASSWORD`, `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID` and
`APPLE_API_ISSUER`, and both jobs need `TAURI_SIGNING_PRIVATE_KEY` (plus `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the
key has one). There is no unsigned fallback: a missing secret fails the run before anything is published. Setup in
`docs/releasing.md`, the update feed and the key in `docs/updater.md`.
