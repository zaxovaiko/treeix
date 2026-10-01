import { app, dialog, type Session } from 'electron'

/** Listed under keychain-access-groups in build/entitlements.mac.app.plist; a build signed without it keeps passkeys off */
const KEYCHAIN_ACCESS_GROUP = 'J9X92WZMA7.com.dyvertex.treeix.webauthn'

/** Touch ID passkeys for the built-in browser. They live in this Mac's keychain, apart from the ones in iCloud or Chrome */
export function enablePasskeys(browser: Session): void {
  if (process.platform !== 'darwin') return
  app.configureWebAuthn({ touchID: { keychainAccessGroup: KEYCHAIN_ACCESS_GROUP } })
  // A site with several passkeys: Electron cancels the sign-in unless something picks one
  browser.on('select-webauthn-account', async (_, { relyingPartyId, accounts }, callback) => {
    let credentialId: string | undefined
    try {
      const names = accounts.map((account) => account.name ?? account.displayName ?? account.credentialId)
      const { response } = await dialog.showMessageBox({ message: `Choose a passkey for ${relyingPartyId}`, buttons: [...names, 'Cancel'], cancelId: names.length })
      credentialId = accounts[response]?.credentialId
    } finally {
      callback(credentialId)
    }
  })
}
