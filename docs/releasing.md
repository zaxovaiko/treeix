# Releasing

## DMG

```sh
bun run dist:dmg   # apps/desktop/dist/Treeix-arm64.dmg, ad-hoc signed
```

Ad-hoc builds open only after System Settings > Privacy & Security > Open Anyway. For a DMG that opens with no warning, create a "Developer ID Application" certificate, then:

```sh
APPLE_ID=... APPLE_APP_SPECIFIC_PASSWORD=... APPLE_TEAM_ID=J9X92WZMA7 bun run --cwd apps/desktop dist:dmg:notarized
```

Upload the DMG to a GitHub release named `Treeix-arm64.dmg`. `/download` on the landing page redirects there (`apps/landing/vercel.json`).

## Mac App Store

1. Create the `com.zaxovaiko.treeix` app ID and a Mac App Store provisioning profile, save it as `apps/desktop/build/embedded.provisionprofile`.
2. Install the "3rd Party Mac Developer Installer" certificate.
3. `bun run dist:mas`, then upload the `.pkg` with Transporter.

The App Store build runs sandboxed: it cannot scan the home folder, run `git`, `gh` or `claude` from Homebrew, or open login shells without extra work.

## Landing page

A Vercel project with Root Directory `apps/landing`, framework preset Other, no build command, domain `treeix.dyvertex.com`.

## Screenshots

`sh apps/desktop/scripts/demo-home.sh /tmp/treeix-demo` creates fake repositories. Run the packaged app against them so no real data shows:

```sh
HOME=/tmp/treeix-demo apps/desktop/dist/mac-arm64/Treeix.app/Contents/MacOS/Treeix --user-data-dir=/tmp/treeix-demo/profile
```
