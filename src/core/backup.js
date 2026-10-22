// Copyright (c) 2026 Fido-labs —kcw—
// Sauvegarde chiffrée portable : clés fournisseurs, proxys, combos, alias, clés clientes (empreintes), réglages.
// Les secrets sont déchiffrés avec le coffre local puis rechiffrés dans une enveloppe protégée par un mot de passe
// (scrypt + AES-256-GCM) : la sauvegarde se restaure sur une autre machine sans le fichier « .secret ».
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from '../config.js';

const FORMAT = 'phenixrouter-backup';
const MIN_PASSWORD = 10;
const KDF = { N: 32768, r: 8, p: 1 };

const kdf = (password, salt) => scryptSync(String(password), salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 128 * 1024 * 1024 });

/** Remplace récursivement les secrets scellés (« enc1:… ») par { $sealed: clair }. */
function unseal(v, vault) {
  if (typeof v === 'string') return v.startsWith('enc1:') ? { $sealed: vault.open(v) } : v;
  if (Array.isArray(v)) return v.map((x) => unseal(x, vault));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unseal(x, vault)]));
  return v;
}

function reseal(v, vault) {
  if (Array.isArray(v)) return v.map((x) => reseal(x, vault));
  if (v && typeof v === 'object') {
    if (Object.keys(v).length === 1 && typeof v.$sealed === 'string') return vault.seal(v.$sealed);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, reseal(x, vault)]));
  }
  return v;
}

export function createBackup(gw, password) {
  if (String(password ?? '').length < MIN_PASSWORD) throw new Error(`Mot de passe de sauvegarde : ${MIN_PASSWORD} caractères minimum`);
  const payload = JSON.stringify({ exportedAt: new Date().toISOString(), appVersion: VERSION, db: unseal(gw.db, gw.vault) });
  const salt = randomBytes(16); const iv = randomBytes(12);
  const head = { format: FORMAT, v: 1, kdf: { name: 'scrypt', ...KDF, salt: salt.toString('base64') }, iv: iv.toString('base64') };
  const c = createCipheriv('aes-256-gcm', kdf(password, salt), iv);
  c.setAAD(Buffer.from(JSON.stringify(head)));
  const ct = Buffer.concat([c.update(payload, 'utf8'), c.final()]);
  return JSON.stringify({ ...head, tag: c.getAuthTag().toString('base64'), data: ct.toString('base64') });
}

export function readBackup(text, password) {
  let env;
  try { env = JSON.parse(text); } catch { throw new Error('Fichier de sauvegarde illisible'); }
  if (env?.format !== FORMAT || env.v !== 1 || env.kdf?.name !== 'scrypt') throw new Error('Ce fichier n’est pas une sauvegarde PhenixRouter');
  const { tag, data, ...head } = env;
  try {
    const d = createDecipheriv('aes-256-gcm', kdf(password, Buffer.from(env.kdf.salt, 'base64')), Buffer.from(env.iv, 'base64'));
    d.setAAD(Buffer.from(JSON.stringify(head)));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8'));
  } catch {
    throw new Error('Mot de passe de sauvegarde incorrect (ou fichier altéré)');
  }
}

/** Remplace la configuration par celle de la sauvegarde (copie de sécurité de db.json avant). Le serveur doit être arrêté. */
export function restoreBackup(gw, text, password) {
  const payload = readBackup(text, password);
  const db = payload?.db;
  if (!db || typeof db !== 'object' || !Array.isArray(db.connections) || !Array.isArray(db.apiKeys) || typeof db.auth !== 'object') throw new Error('Sauvegarde invalide : structure inattendue');
  gw.store.flush();
  let safety = null;
  if (existsSync(gw.store.file)) { safety = `${gw.store.file}.avant-restauration-${Date.now()}`; copyFileSync(gw.store.file, safety); }
  const next = reseal(db, gw.vault);
  for (const k of Object.keys(gw.db)) delete gw.db[k];
  Object.assign(gw.db, next);
  for (const [k, v] of Object.entries(gw.store.defaults)) if (gw.db[k] === undefined) gw.db[k] = JSON.parse(JSON.stringify(v));
  gw.store.flush();
  return { exportedAt: payload.exportedAt, appVersion: payload.appVersion, connections: gw.db.connections.length, apiKeys: gw.db.apiKeys.length, proxies: gw.db.proxies?.length ?? 0, safety };
}
