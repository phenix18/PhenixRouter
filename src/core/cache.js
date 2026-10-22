// Copyright (c) 2026 Fido-labs —kcw—
// Cache LRU des réponses déterministes (temperature = 0) : économise le quota gratuit.
import { createHash } from 'node:crypto';

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const NEG = new Set(['ne', 'pas', 'non', 'sans', 'jamais', 'aucun', 'not', 'no', 'never', 'without', 'cannot', 'dont', 'isnt', 'wont']);

/** Empreinte sémantique légère (sans API ni modèle) : mots normalisés, nombres et négations. */
export function semanticSignature(text) {
  const norm = String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/['’`]/g, ' ');
  const words = norm.match(/[a-z0-9]+(?:[.,][0-9]+)?/g) ?? [];
  const nums = words.filter((w) => /\d/.test(w)).sort().join(',');
  const neg = words.some((w) => NEG.has(w)); // « ne … pas » compte une seule fois
  const grams = new Set(words.length >= 3 ? words.slice(1).map((w, i) => `${words[i]} ${w}`) : words);
  return { grams, nums, neg, n: words.length };
}

export function similarity(a, b) {
  if (a.nums !== b.nums || a.neg !== b.neg || !a.grams.size || !b.grams.size) return 0;
  let inter = 0;
  for (const g of a.grams) if (b.grams.has(g)) inter += 1;
  return inter / (a.grams.size + b.grams.size - inter);
}

export class ResponseCache {
  constructor({ max = 200, ttlMs = 600_000 } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map();
    this.sem = new Map(); // contexte → Set de clés (recherche approchée, facultative)
    this.semHits = 0;
    this.hits = 0;
    this.misses = 0;
  }

  configure({ max, ttlMs }) {
    if (max != null) this.max = max;
    if (ttlMs != null) this.ttlMs = ttlMs;
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }

  static key(obj) {
    return createHash('sha256').update(stable(obj)).digest('hex');
  }

  get(key) {
    const e = this.map.get(key);
    if (!e) { this.misses += 1; return undefined; }
    if (Date.now() > e.exp) { this.map.delete(key); this.misses += 1; return undefined; }
    this.map.delete(key);
    this.map.set(key, e); // LRU : remonte en tête
    this.hits += 1;
    return structuredClone(e.value);
  }

  set(key, value, sem = null) {
    if (this.max <= 0) return;
    this.map.delete(key);
    this.map.set(key, { value: structuredClone(value), exp: Date.now() + this.ttlMs, sem });
    if (sem) {
      if (!this.sem.has(sem.ctx)) this.sem.set(sem.ctx, new Set());
      this.sem.get(sem.ctx).add(key);
    }
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }

  /** Réponse d'une requête « presque identique » (même contexte, dernière question très proche), ou undefined. */
  getSimilar(ctx, text, threshold) {
    const keys = this.sem.get(ctx);
    if (!keys) return undefined;
    const sig = semanticSignature(text);
    if (sig.n < 4) return undefined; // trop court pour une comparaison fiable : exact seulement
    let best = null; let bestScore = 0; let scanned = 0;
    for (const k of keys) {
      const e = this.map.get(k);
      if (!e) { keys.delete(k); continue; }
      if (Date.now() > e.exp) { this.map.delete(k); keys.delete(k); continue; }
      if ((scanned += 1) > 100) break;
      const sc = similarity(sig, e.sem.sig);
      if (sc >= threshold && sc > bestScore) { best = e; bestScore = sc; }
    }
    if (!best) return undefined;
    this.semHits += 1;
    return structuredClone(best.value);
  }

  clear() {
    this.map.clear();
    this.sem.clear();
  }

  stats() {
    return { size: this.map.size, hits: this.hits, misses: this.misses, semanticHits: this.semHits };
  }
}
