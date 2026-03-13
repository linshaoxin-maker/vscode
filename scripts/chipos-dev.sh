#!/usr/bin/env bash
set -e
ROOT=$(dirname "$(dirname "$(realpath "$0")")")
cd "$ROOT"

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 22.22.0 2>/dev/null

unset ELECTRON_RUN_AS_NODE

NAME=$(node -p "require('./product.json').nameLong")
EXE_NAME=$(node -p "require('./product.json').nameShort")

if [[ "$OSTYPE" == "darwin"* ]]; then
    CODE="./.build/electron/$NAME.app/Contents/MacOS/$EXE_NAME"
else
    CODE=".build/electron/$NAME"
fi

export NODE_ENV=development
export VSCODE_DEV=1
export VSCODE_CLI=1
export ELECTRON_ENABLE_LOGGING=1
export VSCODE_SKIP_PRELAUNCH=1

echo "[ChipOS] Launching $NAME..."
exec "$CODE" . --disable-extension=vscode.vscode-api-tests "$@"
