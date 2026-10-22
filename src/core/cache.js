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

export class ResponseCache {
  constructor({ max = 200, ttlMs = 600_000 } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map();
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

  set(key, value) {
    if (this.max <= 0) return;
    this.map.delete(key);
    this.map.set(key, { value: structuredClone(value), exp: Date.now() + this.ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }

  clear() {
    this.map.clear();
  }

  stats() {
    return { size: this.map.size, hits: this.hits, misses: this.misses };
  }
}
