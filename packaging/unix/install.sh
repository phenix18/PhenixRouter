#!/usr/bin/env sh
# PhenixRouter — installateur Linux (systemd utilisateur) et macOS (launchd). Aucun droit root requis.
# Copyright (c) 2026 Fido-labs —kcw—
set -eu

OS="$(uname -s)"; ARCH="$(uname -m)"
case "$ARCH" in x86_64|amd64) A=x64 ;; arm64|aarch64) A=arm64 ;; *) echo "Architecture non gérée : $ARCH"; exit 1 ;; esac
case "$OS" in Linux) P=linux ;; Darwin) P=darwin ;; *) echo "Système non géré : $OS"; exit 1 ;; esac

HERE="$(cd "$(dirname "$0")" && pwd)"
BIN=""
for c in "$HERE/phenixrouter-$P-$A" "$HERE/../../dist/phenixrouter-$P-$A"; do [ -f "$c" ] && BIN="$c" && break; done
[ -n "$BIN" ] || { echo "phenixrouter-$P-$A introuvable : téléchargez-le depuis « Releases » ou lancez  npm run build:exe"; exit 1; }

DEST="$HOME/.local/bin"
mkdir -p "$DEST"
install -m 755 "$BIN" "$DEST/phenixrouter"
echo "✓ Installé : $DEST/phenixrouter"
case ":$PATH:" in *":$DEST:"*) ;; *) echo "  (ajoutez $DEST à votre PATH : export PATH=\"\$HOME/.local/bin:\$PATH\")" ;; esac

printf "Lancer PhenixRouter automatiquement à l'ouverture de session ? [o/N] "
read -r ans || ans=n
case "$ans" in
  o|O|y|Y)
    if [ "$OS" = "Linux" ]; then
      UNIT_DIR="$HOME/.config/systemd/user"; mkdir -p "$UNIT_DIR"
      cat > "$UNIT_DIR/phenixrouter.service" <<UNIT
[Unit]
Description=PhenixRouter — passerelle IA gratuite
After=network-online.target

[Service]
ExecStart=$DEST/phenixrouter start --no-browser
Restart=on-failure
RestartSec=3
Environment=PHENIX_NO_BROWSER=1

[Install]
WantedBy=default.target
UNIT
      systemctl --user daemon-reload && systemctl --user enable --now phenixrouter.service && echo "✓ Service systemd utilisateur actif (journal : journalctl --user -u phenixrouter)"
      echo "  Identifiants du premier lancement : journalctl --user -u phenixrouter | head -30"
    else
      PLIST="$HOME/Library/LaunchAgents/com.fido-labs.phenixrouter.plist"; mkdir -p "$(dirname "$PLIST")"
      cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.fido-labs.phenixrouter</string>
  <key>ProgramArguments</key><array><string>$DEST/phenixrouter</string><string>start</string><string>--no-browser</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/phenixrouter.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/phenixrouter.log</string>
</dict></plist>
PL
      launchctl unload "$PLIST" 2>/dev/null || true
      launchctl load "$PLIST" && echo "✓ Agent launchd actif (journal : ~/Library/Logs/phenixrouter.log)"
    fi ;;
  *) echo "Lancez-le à la main :  phenixrouter start" ;;
esac

if [ "$OS" = "Linux" ]; then
  APPS="$HOME/.local/share/applications"; mkdir -p "$APPS"
  cat > "$APPS/phenixrouter.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=PhenixRouter
Comment=Passerelle IA gratuite (OpenAI / Anthropic)
Exec=$DEST/phenixrouter start
Terminal=true
Categories=Development;Network;
DESK
fi
echo "Tableau de bord : http://127.0.0.1:20128"
