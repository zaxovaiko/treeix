#!/bin/sh
# `electron-vite dev` runs the stock Electron.app. macOS takes the menu bar name from its Info.plist
# and the Dock name from the bundle folder, so rename both in this dev copy; packaged builds get
# Treeix from productName. path.txt is how the electron package finds the binary.
[ "$(uname)" = Darwin ] || exit 0
dist=node_modules/electron/dist
[ -d "$dist/Electron.app" ] && [ ! -d "$dist/Treeix.app" ] && mv "$dist/Electron.app" "$dist/Treeix.app"
[ -d "$dist/Treeix.app" ] || exit 0
printf 'Treeix.app/Contents/MacOS/Electron' > node_modules/electron/path.txt
/usr/libexec/PlistBuddy -c "Set :CFBundleName Treeix" -c "Set :CFBundleDisplayName Treeix" "$dist/Treeix.app/Contents/Info.plist"
# The meetings plugin's permission prompts need their reasons in the plist that asks; Add fails harmlessly once they're there
for key in NSAudioCaptureUsageDescription NSCalendarsFullAccessUsageDescription NSAppleEventsUsageDescription; do
  /usr/libexec/PlistBuddy -c "Add :$key string Treeix (dev) records and transcribes meetings." "$dist/Treeix.app/Contents/Info.plist" 2>/dev/null
done
exit 0
