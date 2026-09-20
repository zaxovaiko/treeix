# Releasing

A `v*` tag runs `.github/workflows/release.yml`, which builds, signs, notarizes and publishes the GitHub release.
That release is also the update feed: `latest-mac.yml` next to the zip is what the app reads.

## In-app updates

`apps/desktop/src/main/updates.ts` checks GitHub ten seconds after launch and every six hours, downloads a newer
build in the background and tells the page, which offers the restart (banner bottom right, and Settings > General >
Updates). Nothing installs without that restart, except on the next quit.

Two things have to hold or the app silently stays on its version:

- **The release carries `latest-mac.yml`.** `electron-builder --publish always` uploads it; a release made by hand
  with `gh release create` does not.
- **The build is signed with a Developer ID certificate.** macOS refuses to swap an app for one with a different
  signature, so ad-hoc builds (`dist:dmg`) can download an update and then fail to apply it.

Dev runs and Mac App Store builds report "handled elsewhere" instead of checking.

## DMG

```sh
bun run dist:dmg   # apps/desktop/dist/Treeix-arm64.dmg, ad-hoc signed, no auto-update
```

Ad-hoc builds open only after System Settings > Privacy & Security > Open Anyway.

## Signing in CI

The workflow signs when `MAC_CERT_P12` and `APPLE_API_KEY_P8` exist, and otherwise falls back to the unsigned DMG,
so a repository without the secrets still releases.

1. **Certificate.** A Developer ID Application certificate, made from a CSR whose private key stays on the Mac:

   ```sh
   mkdir -p ~/.treeix-signing && chmod 700 ~/.treeix-signing
   openssl req -new -newkey rsa:2048 -nodes \
     -keyout ~/.treeix-signing/developerID.key -out ~/.treeix-signing/developerID.csr \
     -subj "/emailAddress=you@example.com/CN=Your Name/C=UA"
   ```

   Upload the CSR at developer.apple.com > Certificates > + > Developer ID Application (Account Holder only),
   download the `.cer`, then:

   ```sh
   sh apps/desktop/scripts/signing-secrets.sh cert ~/Downloads/developerID_application.cer
   ```

   It chains Apple's intermediate, builds a `.p12` with a random password and sets `MAC_CERT_P12` and
   `MAC_CERT_PASSWORD` through `gh secret set`, so neither value is printed.

2. **Notarization key.** App Store Connect > Users and Access > Integrations > Keys, role Developer. Keep the
   `.p8`, its Key ID and the Issuer ID:

   ```sh
   sh apps/desktop/scripts/signing-secrets.sh notary ~/Downloads/AuthKey_ABC123.p8 ABC123 <issuer-uuid>
   ```

3. Tag and push. Notarization adds a few minutes to the run.

Locally the same build is:

```sh
APPLE_API_KEY=~/.treeix-signing/AuthKey.p8 APPLE_API_KEY_ID=... APPLE_API_ISSUER=... \
  bun run --cwd apps/desktop dist:dmg:notarized
```

The landing page's `/download` redirects to the release asset named `Treeix-arm64.dmg` (`apps/landing/vercel.json`).

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
