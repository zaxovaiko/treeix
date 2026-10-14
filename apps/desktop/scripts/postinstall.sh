#!/bin/sh
set -e
if [ "$(uname)" = Darwin ]; then
  chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper
  node-gyp rebuild -C native/mac-window
else
  # node-pty ships prebuilds for macOS and Windows only; it is N-API, so a build against Node's headers loads in Electron
  node-gyp rebuild -C node_modules/node-pty
fi
sh scripts/dev-app-name.sh
