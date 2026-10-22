// Copyright (c) 2026 Fido-labs —kcw—
// Service permanent « sans droits administrateur » : systemd (utilisateur), launchd, tâche planifiée Windows.
// Les fonctions de génération sont pures (testables) ; l'exécution des commandes système est injectable.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export const SERVICE = Object.freeze({ name: 'phenixrouter', label: 'com.fido-labs.phenixrouter', task: 'PhenixRouter' });

const isNodeBinary = (p) => /^node(js)?(\.exe)?$/i.test(basename(p));

/** Commande qui relance PhenixRouter : exécutable autonome, ou « node bin/phenixrouter.js ». */
export function launcher({ execPath = process.execPath, script = process.argv[1] } = {}) {
  if (!isNodeBinary(execPath)) return { cmd: execPath, args: [] };
  return { cmd: execPath, args: [resolve(script)] };
}

export function startArgs({ port, host, dataDir } = {}) {
  const a = ['start', '--no-browser'];
  if (port) a.push('--port', String(port));
  if (host) a.push('--host', String(host));
  if (dataDir) a.push('--data-dir', resolve(dataDir));
  return a;
}

const sdQuote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function systemdUnit({ cmd, args }) {
  return `[Unit]
Description=PhenixRouter — passerelle IA gratuite/payante
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${[cmd, ...args].map(sdQuote).join(' ')}
Restart=on-failure
RestartSec=3
Environment=PHENIX_NO_BROWSER=1
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
}

export function launchdPlist({ cmd, args }, logFile) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SERVICE.label}</string>
  <key>ProgramArguments</key><array>${[cmd, ...args].map((x) => `<string>${xml(x)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict></plist>
`;
}

/** Arguments de schtasks /Create (ouverture de session, droits limités). */
export function schtasksCreate({ cmd, args }) {
  const q = (s) => `"${String(s).replace(/"/g, '')}"`;
  return ['/Create', '/F', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TN', SERVICE.task, '/TR', [cmd, ...args].map(q).join(' ')];
}

const defaultRun = (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function paths(platform, home) {
  if (platform === 'linux') return { file: join(home, '.config', 'systemd', 'user', `${SERVICE.name}.service`) };
  if (platform === 'darwin') return { file: join(home, 'Library', 'LaunchAgents', `${SERVICE.label}.plist`), log: join(home, 'Library', 'Logs', 'phenixrouter.log') };
  return { file: null };
}

/**
 * @param {'install'|'uninstall'|'status'} action
 * @param {{platform?:string, home?:string, run?:Function, spec?:object, opts?:object}} o
 * @returns {{ok:boolean, platform:string, file?:string, steps:string[], notes:string[], state?:string}}
 */
export function manageService(action, { platform = process.platform, home = homedir(), run = defaultRun, spec, opts = {} } = {}) {
  const sp = spec ?? { ...launcher(), args: [...launcher().args, ...startArgs(opts)] };
  const p = paths(platform, home);
  const steps = []; const notes = [];
  const sh = (file, args, { ignore = false } = {}) => {
    steps.push(`${file} ${args.join(' ')}`);
    try { return run(file, args); } catch (e) { if (!ignore) throw new Error(`${file} a échoué : ${String(e.stderr || e.message).trim().slice(0, 300)}`); return ''; }
  };
  if (platform === 'linux') {
    if (action === 'install') {
      mkdirSync(join(p.file, '..'), { recursive: true });
      writeFileSync(p.file, systemdUnit(sp), { mode: 0o644 });
      sh('systemctl', ['--user', 'daemon-reload']);
      sh('systemctl', ['--user', 'enable', '--now', `${SERVICE.name}.service`]);
      notes.push('Identifiants du premier lancement : journalctl --user -u phenixrouter | head -30');
      notes.push('Pour démarrer sans session ouverte : loginctl enable-linger $USER');
    } else if (action === 'uninstall') {
      sh('systemctl', ['--user', 'disable', '--now', `${SERVICE.name}.service`], { ignore: true });
      if (existsSync(p.file)) rmSync(p.file);
      sh('systemctl', ['--user', 'daemon-reload'], { ignore: true });
    } else {
      const out = sh('systemctl', ['--user', 'is-active', `${SERVICE.name}.service`], { ignore: true });
      return { ok: true, platform, file: p.file, steps, notes, state: String(out).trim() || (existsSync(p.file) ? 'inactive' : 'not-installed') };
    }
  } else if (platform === 'darwin') {
    if (action === 'install') {
      mkdirSync(join(p.file, '..'), { recursive: true }); mkdirSync(join(p.log, '..'), { recursive: true });
      writeFileSync(p.file, launchdPlist(sp, p.log));
      sh('launchctl', ['unload', p.file], { ignore: true });
      sh('launchctl', ['load', '-w', p.file]);
      notes.push(`Journal : ${p.log}`);
    } else if (action === 'uninstall') {
      sh('launchctl', ['unload', '-w', p.file], { ignore: true });
      if (existsSync(p.file)) rmSync(p.file);
    } else {
      const out = sh('launchctl', ['list', SERVICE.label], { ignore: true });
      return { ok: true, platform, file: p.file, steps, notes, state: out ? 'loaded' : (existsSync(p.file) ? 'inactive' : 'not-installed') };
    }
  } else if (platform === 'win32') {
    if (action === 'install') {
      sh('schtasks', schtasksCreate(sp));
      sh('schtasks', ['/Run', '/TN', SERVICE.task], { ignore: true });
      notes.push('Tâche planifiée « PhenixRouter » (à l’ouverture de session, sans droits administrateur).');
    } else if (action === 'uninstall') {
      sh('schtasks', ['/End', '/TN', SERVICE.task], { ignore: true });
      sh('schtasks', ['/Delete', '/F', '/TN', SERVICE.task], { ignore: true });
    } else {
      const out = sh('schtasks', ['/Query', '/TN', SERVICE.task], { ignore: true });
      return { ok: true, platform, steps, notes, state: out ? 'installed' : 'not-installed' };
    }
  } else {
    throw new Error(`Système non pris en charge pour le service : ${platform}`);
  }
  return { ok: true, platform, file: p.file ?? undefined, steps, notes };
}
