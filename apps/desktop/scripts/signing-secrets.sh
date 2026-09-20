#!/bin/sh
# Turns the Developer ID certificate and the notarization key into the repository secrets the release
# workflow reads. Values go from file to `gh secret set` without passing through the terminal.
#
#   sh apps/desktop/scripts/signing-secrets.sh cert ~/Downloads/developerID_application.cer
#   sh apps/desktop/scripts/signing-secrets.sh notary ~/Downloads/AuthKey_ABC123.p8 ABC123 <issuer-uuid>
#
# The private key and the .p12 stay in ~/.treeix-signing (chmod 600); nothing signing-related belongs in git.
set -eu

DIR="${TREEIX_SIGNING_DIR:-$HOME/.treeix-signing}"
KEY="$DIR/developerID.key"
P12="$DIR/DeveloperID.p12"
PASSWORD_FILE="$DIR/p12-password"
# Apple's intermediate; a .p12 without it signs, but notarization rejects the broken chain
INTERMEDIATE_URL="https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer"

usage() {
  echo "usage: $0 cert <developerID_application.cer> | notary <AuthKey.p8> <key-id> <issuer-id>" >&2
  exit 64
}

case "${1:-}" in
  cert)
    CER="${2:-}"
    [ -f "$CER" ] || usage
    [ -f "$KEY" ] || { echo "no private key at $KEY; the certificate must come from the CSR made with it" >&2; exit 1; }
    umask 077
    openssl x509 -inform DER -in "$CER" -out "$DIR/developerID.pem"
    curl -fsSL "$INTERMEDIATE_URL" -o "$DIR/intermediate.cer"
    openssl x509 -inform DER -in "$DIR/intermediate.cer" -out "$DIR/intermediate.pem"
    # A fresh random password: the workflow is the only reader, so nobody has to remember it
    openssl rand -base64 24 > "$PASSWORD_FILE"
    openssl pkcs12 -export -legacy \
      -inkey "$KEY" -in "$DIR/developerID.pem" -certfile "$DIR/intermediate.pem" \
      -name "Developer ID Application" -out "$P12" -passout "file:$PASSWORD_FILE"
    base64 -i "$P12" -o "$DIR/DeveloperID.p12.base64"
    gh secret set MAC_CERT_P12 < "$DIR/DeveloperID.p12.base64"
    gh secret set MAC_CERT_PASSWORD < "$PASSWORD_FILE"
    echo "MAC_CERT_P12 and MAC_CERT_PASSWORD set; $P12 kept for local signing"
    ;;
  notary)
    P8="${2:-}"
    KEY_ID="${3:-}"
    ISSUER="${4:-}"
    [ -f "$P8" ] && [ -n "$KEY_ID" ] && [ -n "$ISSUER" ] || usage
    umask 077
    base64 -i "$P8" -o "$DIR/AuthKey.p8.base64"
    gh secret set APPLE_API_KEY_P8 < "$DIR/AuthKey.p8.base64"
    printf '%s' "$KEY_ID" | gh secret set APPLE_API_KEY_ID
    printf '%s' "$ISSUER" | gh secret set APPLE_API_ISSUER
    echo "APPLE_API_KEY_P8, APPLE_API_KEY_ID and APPLE_API_ISSUER set"
    ;;
  *) usage ;;
esac
