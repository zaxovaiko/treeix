# Releasing

Every push to `main` that touches the app (`apps/desktop`, `crates`, `Cargo.*`, `rust-toolchain.toml`; markdown
skipped) runs `.github/workflows/release.yml`, which picks the next version, builds the Mac and Linux apps, signs,
notarizes and publishes the GitHub release, tagging the pushed commit.

- **Patch**: any push.
- **Major**: a commit since the latest tag marked breaking, `feat(scope)!:` or a `BREAKING CHANGE:` body line.
- **Minor**: set it in `apps/desktop/package.json` above the latest tag and push; the workflow ships that version as is.

`tauri.conf.json` reads its version from `apps/desktop/package.json`. The workflow bumps that file in the build only,
never on `main`, so it lags behind patch releases on purpose.

The release notes come from the same commits (`apps/desktop/scripts/release-notes.sh`): breaking changes, `feat`
and `fix` subjects grouped and scope first, other types left out, and a link to the full compare.

## What a release carries

- `Treeix.dmg`: the universal Mac app (Apple silicon and Intel), signed, notarized and stapled. The landing page's
  `/download` redirects here (`vercel.json`).
- `Treeix.app.tar.gz` and its `.sig`: the Mac update bundle.
- `Treeix-x86_64.AppImage` and its `.sig`: Linux, built on Ubuntu 22.04, and its own update.
- `latest.json`: the update feed, uploaded last.

The release stays a draft until every job is done, so installed copies only see a complete one. In-app updates and
the signing key: `docs/updater.md`.

## Signing in CI

The Mac job needs these secrets and fails without them:

- `MAC_CERT_P12` (base64 `.p12` of the Developer ID Application certificate with Apple's intermediate) and
  `MAC_CERT_PASSWORD`. The job imports it into its own keychain and hands Tauri the identity.
- `APPLE_API_KEY_P8` (base64 `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`: an App Store Connect API key, role
  Developer, for notarization.
- `TAURI_SIGNING_PRIVATE_KEY` (both jobs), plus `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key has one.

Tauri signs the app and every sidecar (`treeix-ptyd`, `treeix-voice`, `treeix-meetings`) with the hardened runtime
and `src-tauri/Entitlements.plist` (microphone, calendars), notarizes and staples the app; the job then notarizes and
staples the DMG.

Setting a secret without printing it:

```sh
base64 -i DeveloperID.p12 | gh secret set MAC_CERT_P12
base64 -i AuthKey_ABC123.p8 | gh secret set APPLE_API_KEY_P8
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/treeix-updater.key
```

## Local build

```sh
cd apps/desktop
bun run app:build   # target/release/bundle at the repo root: Treeix.app and the DMG on a Mac, the AppImage on Linux
```

Unsigned unless `APPLE_SIGNING_IDENTITY` is set; an unsigned app opens only after System Settings > Privacy &
Security > Open Anyway.

## Landing page

A Vercel project with Root Directory `apps/landing`, framework preset Other, no build command, domain `treeix.dyvertex.com`.
