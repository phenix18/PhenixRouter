// Copyright (c) 2026 Fido-labs —kcw—
// Limiteur à fenêtre glissante (par clé API cliente, ou par IP pour la connexion).

export class RateLimiter {
  constructor() {
    this.hits = new Map();
  }

  /** @returns {{ok:boolean, retryAfterSec:number}} */
  hit(key, limit, windowMs = 60_000) {
    if (!limit || limit <= 0) return { ok: true, retryAfterSec: 0 };
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= limit) {
      this.hits.set(key, arr);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((windowMs - (now - arr[0])) / 1000)) };
    }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 5000) this.gc(windowMs);
    return { ok: true, retryAfterSec: 0 };
  }

  gc(windowMs = 60_000) {
    const now = Date.now();
    for (const [k, arr] of this.hits) {
      if (!arr.length || now - arr[arr.length - 1] > windowMs) this.hits.delete(k);
    }
  }
}
