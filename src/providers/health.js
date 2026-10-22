// Copyright (c) 2026 Fido-labs —kcw—
// Santé des connexions : latence (EWMA), coupe-circuit avec repli exponentiel.

const MAX_COOLDOWN_MS = 10 * 60 * 1000;

export class Health {
  constructor() {
    this.map = new Map();
  }

  _entry(key) {
    let e = this.map.get(key);
    if (!e) {
      e = { ewma: null, ok: 0, fail: 0, consecutive: 0, openUntil: 0, lastError: null, lastKind: null, lastOkAt: 0, lastFailAt: 0 };
      this.map.set(key, e);
    }
    return e;
  }

  get(key) {
    return { ...this._entry(key) };
  }

  success(key, ms) {
    const e = this._entry(key);
    e.ok += 1;
    e.consecutive = 0;
    e.openUntil = 0;
    e.lastError = null;
    e.lastKind = null;
    e.lastOkAt = Date.now();
    e.ewma = e.ewma == null ? ms : Math.round(e.ewma * 0.7 + ms * 0.3);
  }

  /**
   * @param {'rate'|'quota'|'auth'|'server'|'network'|'client'} kind
   * @param {number} [retryAfterMs]
   */
  failure(key, kind, message = '', retryAfterMs = 0) {
    const e = this._entry(key);
    e.fail += 1;
    e.lastError = String(message).slice(0, 200);
    e.lastKind = kind;
    e.lastFailAt = Date.now();
    if (kind === 'client') return; // erreur de requête : la connexion n'y est pour rien
    e.consecutive += 1;
    let cooldown;
    switch (kind) {
      case 'rate': cooldown = retryAfterMs || 30_000; break;
      case 'quota': cooldown = retryAfterMs || 60 * 60 * 1000; break;
      case 'auth': cooldown = 10 * 60 * 1000; break;
      default: cooldown = Math.min(MAX_COOLDOWN_MS, 5_000 * 2 ** Math.min(e.consecutive - 1, 7));
    }
    e.openUntil = Date.now() + Math.min(Math.max(cooldown, 1000), 24 * 60 * 60 * 1000);
  }

  available(key) {
    return Date.now() >= this._entry(key).openUntil;
  }

  cooldownLeftMs(key) {
    return Math.max(0, this._entry(key).openUntil - Date.now());
  }

  /** Plus bas = meilleur. Combine latence et fiabilité récente. */
  score(key) {
    const e = this._entry(key);
    const base = e.ewma ?? 900;
    const total = e.ok + e.fail;
    const failRate = total ? e.fail / total : 0;
    return Math.round(base * (1 + e.consecutive * 0.6) * (1 + failRate));
  }

  reset(key) {
    this.map.delete(key);
  }
}

/**
 * Durée d'attente suggérée par le fournisseur (en ms), 0 si inconnue.
 * Gère l'en-tête Retry-After et les messages du type « try again in 7m12.5s ».
 */
export function parseRetryAfter(headers, bodyText = '') {
  const h = headers?.get?.('retry-after');
  if (h) {
    const n = Number(h);
    if (Number.isFinite(n)) return Math.round(n * 1000);
    const d = Date.parse(h);
    if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
  }
  const m = /(?:try again|retry)[^0-9]{0,20}((?:\d+(?:\.\d+)?\s*(?:ms|h|m|s)\s*)+)/i.exec(String(bodyText));
  if (m) {
    let total = 0;
    for (const part of m[1].matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|m|s)/gi)) {
      const v = Number(part[1]);
      const u = part[2].toLowerCase();
      total += u === 'ms' ? v : u === 's' ? v * 1000 : u === 'm' ? v * 60_000 : v * 3_600_000;
    }
    return Math.round(total);
  }
  return 0;
}
