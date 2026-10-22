// Copyright (c) 2026 Fido-labs —kcw—
// Diagnostic « phenixrouter doctor » : vérifie l'environnement avant (ou après) le premier lancement.
import net from 'node:net';
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDERS } from '../providers/registry.js';
import { Tunnel } from './tunnel.js';

const ok = (name, detail = '') => ({ name, status: 'ok', detail });
const warn = (name, detail) => ({ name, status: 'warn', detail });
const fail = (name, detail) => ({ name, status: 'fail', detail });

function portFree(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (e) => resolve(e.code === 'EADDRINUSE' ? false : null));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

/** @returns {Promise<Array<{name:string,status:'ok'|'warn'|'fail',detail:string}>>} */
export async function runDoctor({ dataDir, port = 20128, host = '127.0.0.1', env = process.env, probeNetwork = true, nodeVersion = process.versions.node } = {}) {
  const out = [];
  const [maj, min] = nodeVersion.split('.').map(Number);
  out.push(maj > 20 || (maj === 20 && min >= 9) ? ok('Node.js', `v${nodeVersion}`) : fail('Node.js', `v${nodeVersion} — version 20.9 ou plus requise`));

  try {
    mkdirSync(dataDir, { recursive: true });
    accessSync(dataDir, constants.R_OK | constants.W_OK);
    out.push(ok('Dossier de données', dataDir));
  } catch (e) { out.push(fail('Dossier de données', `${dataDir} — ${e.code ?? e.message}`)); }
  out.push(existsSync(join(dataDir, 'db.json')) ? ok('Configuration', 'db.json présent') : warn('Configuration', 'première utilisation (créée au premier lancement)'));

  const free = await portFree(port, host);
  out.push(free === true ? ok('Port', `${host}:${port} libre`) : free === false ? warn('Port', `${host}:${port} déjà utilisé (PhenixRouter déjà lancé ? sinon changez --port)`) : warn('Port', `${host}:${port} non vérifiable`));
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') out.push(warn('Exposition', `écoute sur ${host} : mot de passe fort, HTTPS et pare-feu recommandés`));

  const withKeys = PROVIDERS.filter((p) => p.keyEnv && env[p.keyEnv]);
  out.push(withKeys.length ? ok('Clés (environnement)', withKeys.map((p) => p.name).join(', ')) : warn('Clés (environnement)', 'aucune ; ajoutez-en dans « Fournisseurs » — Pollinations marche sans clé'));
  const t = new Tunnel().status().available;
  out.push(ok('Tunnels', `cloudflared ${t.cloudflared ? 'présent' : 'absent'} · tailscale ${t.tailscale ? 'présent' : 'absent'} (facultatifs)`));

  if (probeNetwork) {
    try {
      const res = await fetch('https://github.com', { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      out.push(ok('Réseau sortant', `HTTPS OK (${res.status})`));
    } catch (e) {
      out.push(warn('Réseau sortant', `HTTPS indisponible (${e?.cause?.code ?? e.message}) — vérifiez Internet ou configurez un proxy`));
    }
  }
  return out;
}
