// Copyright (c) 2026 Fido-labs —kcw—
// Persistance JSON atomique + coffre de chiffrement des secrets (AES-256-GCM)
import {
  mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, chmodSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  randomBytes, createCipheriv, createDecipheriv, createHmac, createHash,
  scryptSync, timingSafeEqual,
} from 'node:crypto';

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.data = null;
    this._timer = null;
  }

  load() {
    ensureDir(dirname(this.file));
    let data = null;
    if (existsSync(this.file)) {
      try {
        data = JSON.parse(readFileSync(this.file, 'utf8'));
      } catch {
        // Fichier corrompu : on le met de côté au lieu de le perdre.
        try { renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      }
    }
    this.data = data && typeof data === 'object' ? data : {};
    for (const [k, v] of Object.entries(this.defaults)) {
      if (this.data[k] === undefined) this.data[k] = clone(v);
    }
    return this.data;
  }

  save() {
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.flush(); }, 120);
    this._timer.unref?.();
  }

  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (!this.data) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

export class Vault {
  constructor(dir) {
    ensureDir(dir);
    const path = join(dir, '.secret');
    if (!existsSync(path)) {
      writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600 });
    }
    try { chmodSync(path, 0o600); } catch { /* ignore (Windows) */ }
    this.key = Buffer.from(readFileSync(path, 'utf8').trim(), 'hex');
    this.macKey = createHmac('sha256', this.key).update('phenix-session-mac').digest();
  }

  seal(plain) {
    if (plain == null || plain === '') return plain;
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return `enc1:${[iv, c.getAuthTag(), ct].map((b) => b.toString('base64')).join(':')}`;
  }

  open(sealed) {
    if (typeof sealed !== 'string' || !sealed.startsWith('enc1:')) return sealed;
    const [iv, tag, ct] = sealed.slice(5).split(':').map((p) => Buffer.from(p, 'base64'));
    const d = createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  }

  sign(payload) {
    return createHmac('sha256', this.macKey).update(payload).digest('hex');
  }
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt1$')) return false;
  const [, saltB64, hashB64] = stored.split('$');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 24) => randomBytes(bytes).toString('base64url');
