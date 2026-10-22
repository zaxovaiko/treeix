# Updater

Treeix Next updates through `tauri-plugin-updater`. The app fetches `latest.json` from the latest GitHub release,
checks the minisign signature of the bundle against the public key in `apps/next/src-tauri/tauri.conf.json`, installs
it and restarts. ptyd keeps the sessions across the restart.

It checks on start (Settings > About > "Check for updates automatically"), from the tray menu and from Settings > About.

## The key

`tauri.conf.json` ships a placeholder pubkey, `REPLACE_WITH_MINISIGN_PUBLIC_KEY_SEE_DOCS_NEXT_UPDATER_MD`. With it every
check fails with a key error, which the app logs on start and shows when the check was asked for. Before the first
Next release:

1. `bunx tauri signer generate -w ~/.tauri/treeix.key` and keep the private key and its password out of the repo.
2. Put the printed public key (the whole base64 line) in `plugins.updater.pubkey`.
3. Add the GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` (the key file's content) and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

Losing the private key means no update ever installs again: users have to download the next build by hand. Rotating
it works the same way.

## The release

- Set `bundle.createUpdaterArtifacts: true` in the release build only (it is off in the repo, because a build without
  `TAURI_SIGNING_PRIVATE_KEY` then fails). The build writes `Treeix.app.tar.gz` and its `.sig` next to the DMG.
- Upload both and a `latest.json` to the release:

```json
{
  "version": "0.2.0",
  "notes": "Release notes, markdown",
  "pub_date": "2026-10-22T12:00:00Z",
  "platforms": {
    "darwin-aarch64": { "signature": "<content of the .sig>", "url": "https://github.com/zaxovaiko/treeix/releases/download/v0.2.0/Treeix.app.tar.gz" },
    "darwin-x86_64": { "signature": "...", "url": "..." },
    "linux-x86_64": { "signature": "...", "url": "....AppImage" }
  }
}
```

`tauri-action` writes `latest.json` itself when `includeUpdaterJson` is on.

`requireSignedVersion` is on: the signature's trusted comment must carry the version `latest.json` announces, so an
old signed bundle can't be served under a newer version. Sign with a Tauri CLI recent enough to record it.

The endpoint is `releases/latest/download/latest.json`, so a draft or prerelease never reaches users.
