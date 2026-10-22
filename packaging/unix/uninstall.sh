#!/usr/bin/env sh
# PhenixRouter — désinstallation Linux/macOS. Copyright (c) 2026 Fido-labs —kcw—
set -eu
if [ "$(uname -s)" = "Linux" ]; then
  systemctl --user disable --now phenixrouter.service 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/phenixrouter.service" "$HOME/.local/share/applications/phenixrouter.desktop"
  systemctl --user daemon-reload 2>/dev/null || true
else
  P="$HOME/Library/LaunchAgents/com.fido-labs.phenixrouter.plist"
  launchctl unload "$P" 2>/dev/null || true; rm -f "$P"
fi
rm -f "$HOME/.local/bin/phenixrouter"
echo "Programme supprimé."
printf "Supprimer aussi vos données (clés chiffrées, historique) dans ~/.phenixrouter ? [o/N] "
read -r a || a=n
case "$a" in o|O|y|Y) rm -rf "$HOME/.phenixrouter"; echo "Données supprimées." ;; esac
