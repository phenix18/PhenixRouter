// Copyright (c) 2026 Fido-labs —kcw—
// Journal d'audit : qui a changé quoi (actions d'administration), chaîné par hachage (SHA-256) pour détecter
// toute altération. Aucune valeur de requête n'est enregistrée (jamais de clé ni de mot de passe).
import { appendFileSync, existsSync, readFileSync, statSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ROTATE_BYTES = 8 * 1024 * 1024;
const GENESIS = '0'.repeat(64);

const h = (prev, body) => createHash('sha256').update(prev + body).digest('hex');

export class AuditLog {
  constructor(dir) {
    this.file = join(dir, 'audit.jsonl');
    this.last = GENESIS;
    this.count = 0;
    if (existsSync(this.file)) {
      for (const e of this._read()) { this.last = e.hash; this.count += 1; }
    }
  }

  _read() {
    try {
      return readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { corrupt: true }; } });
    } catch { return []; }
  }

  /** @param {{actor:string, ip?:string, action:string, status?:number, detail?:string}} e */
  record(e) {
    const entry = {
      ts: Date.now(), actor: String(e.actor ?? '?').slice(0, 60), ip: String(e.ip ?? '').slice(0, 64),
      action: String(e.action).slice(0, 120), status: e.status ?? null, detail: e.detail ? String(e.detail).slice(0, 200) : undefined,
      prev: this.last,
    };
    entry.hash = h(entry.prev, JSON.stringify({ ...entry, hash: undefined }));
    try {
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      this.last = entry.hash;
      this.count += 1;
      if (this.count % 200 === 0 && statSync(this.file).size > ROTATE_BYTES) {
        renameSync(this.file, `${this.file}.${Date.now()}`);
        this.last = entry.hash; // la chaîne continue : la nouvelle tête référence le dernier hachage
      }
    } catch { /* best-effort : ne bloque jamais l'administration */ }
    return entry;
  }

  recent(limit = 100) {
    return this._read().filter((e) => !e.corrupt).slice(-limit).reverse();
  }

  /** Vérifie la chaîne du fichier courant. Renvoie { ok, entries, brokenAt? }. */
  verify() {
    const rows = this._read();
    let prev = null;
    for (let i = 0; i < rows.length; i += 1) {
      const e = rows[i];
      if (e.corrupt) return { ok: false, entries: rows.length, brokenAt: i + 1, reason: 'ligne illisible' };
      if (prev !== null && e.prev !== prev) return { ok: false, entries: rows.length, brokenAt: i + 1, reason: 'chaînage rompu' };
      if (h(e.prev, JSON.stringify({ ...e, hash: undefined })) !== e.hash) return { ok: false, entries: rows.length, brokenAt: i + 1, reason: 'entrée modifiée' };
      prev = e.hash;
    }
    return { ok: true, entries: rows.length };
  }
}
