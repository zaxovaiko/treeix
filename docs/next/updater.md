# Updater

Treeix updates through `tauri-plugin-updater`. The app fetches `latest.json` from the latest GitHub release,
checks the minisign signature of the bundle against the public key in `apps/desktop/src-tauri/tauri.conf.json`,
installs it and restarts. ptyd keeps the sessions across the restart.

It checks on start (Settings > About > "Check for updates automatically"), from the tray menu and from Settings > About.

## The key

`plugins.updater.pubkey` in `tauri.conf.json` is the public half of a minisign keypair. The private half lives in
`~/.tauri/treeix-updater.key` on the owner's Mac (no password) and in the `TAURI_SIGNING_PRIVATE_KEY` secret:

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/treeix-updater.key
```

A key with a password also needs `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; without one the secret stays unset.

Losing the private key means no update ever installs again: users have to download the next build by hand. Rotating
it is the same: `bunx tauri signer generate --ci -w ~/.tauri/treeix-updater.key --force`, the new `.pub` content into
`pubkey`, the secret again. Installed builds verify with the pubkey they shipped, so they need one manual update.

## The release

`.github/workflows/release.yml` builds with `bundle.createUpdaterArtifacts` on (off in the repo, so local builds
need no key) and uploads to the release:

- `Treeix.app.tar.gz` and its `.sig`: the universal Mac app, for both `darwin-aarch64` and `darwin-x86_64`.
- `Treeix-x86_64.AppImage` and its `.sig`: the AppImage is its own update, for `linux-x86_64`.
- `latest.json`, written last from both signatures:

```json
{
  "version": "0.2.0",
  "notes": "Release notes, markdown",
  "pub_date": "2026-10-22T12:00:00Z",
  "platforms": {
    "darwin-aarch64": { "signature": "<content of the .sig>", "url": "https://github.com/zaxovaiko/treeix/releases/download/v0.2.0/Treeix.app.tar.gz" },
    "darwin-x86_64": { "signature": "...", "url": ".../Treeix.app.tar.gz" },
    "linux-x86_64": { "signature": "...", "url": ".../Treeix-x86_64.AppImage" }
  }
}
```

`requireSignedVersion` is on: the signature's trusted comment must carry the version `latest.json` announces, so an
old signed bundle can't be served under a newer version. `tauri build` records it (CLI 2.12+); the version comes from
`apps/desktop/package.json`, which the workflow bumps before building.

The endpoint is `releases/latest/download/latest.json`, so a draft or prerelease never reaches users.
