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
