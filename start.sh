#!/usr/bin/env sh
# PhenixRouter — lancement depuis les sources (Node.js 20.9+). Copyright (c) 2026 Fido-labs —kcw—
command -v node >/dev/null 2>&1 || { echo "Node.js 20.9+ requis : https://nodejs.org"; exit 1; }
exec node "$(dirname "$0")/bin/phenixrouter.js" start "$@"
