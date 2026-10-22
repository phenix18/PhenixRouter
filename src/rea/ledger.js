// Copyright (c) 2026 Fido-labs —kcw—
// Grand livre REA : journal append-only (JSONL) + agrégats en mémoire.
import {
  appendFile, existsSync, statSync, openSync, readSync, closeSync, renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { ensureDir } from '../store.js';
import {
  exchangeEvents, checkDuality, EventType, ResourceType,
} from './model.js';

const MAX_TAIL_BYTES = 16 * 1024 * 1024;
const ROTATE_BYTES = 64 * 1024 * 1024;
const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

function readTail(file, maxBytes) {
  const size = statSync(file).size;
  const start = Math.max(0, size - maxBytes);
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // première ligne potentiellement tronquée
    return text;
  } finally {
    closeSync(fd);
  }
}

export class Ledger {
  constructor(dir, { maxExchanges = 20000 } = {}) {
    ensureDir(dir);
    this.file = join(dir, 'ledger.jsonl');
    this.maxExchanges = maxExchanges;
    this.events = [];
    this.exchanges = [];
    this.daily = new Map(); // `${connection}:${day}` → nombre de requêtes
    this._writes = 0;
    this._load();
  }

  _load() {
    if (!existsSync(this.file)) return;
    const pending = new Map();
    for (const line of readTail(this.file, MAX_TAIL_BYTES).split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      this._ingest(e, pending);
    }
  }

  _ingest(e, pending) {
    // Moitié de paire (début de fichier tronqué) : ignorée pour garder l'invariant de dualité.
    if (e.type === EventType.COMPLETION && !pending.has(e.dualityId)) return;
    this.events.push(e);
    if (e.type === EventType.REQUEST) {
      pending.set(e.dualityId, e);
    } else if (e.type === EventType.COMPLETION) {
      // On ne rogne qu'une fois la paire complète, pour ne jamais couper un échange en deux.
      if (this.events.length > this.maxExchanges * 2) this.events.splice(0, this.events.length - this.maxExchanges * 2);
      const req = pending.get(e.dualityId);
      pending.delete(e.dualityId);
      const qty = (ev, type) => ev.resources.find((r) => r.type === type)?.qty ?? 0;
      const ex = {
        id: e.dualityId,
        ts: req.ts,
        client: req.from.replace(/^client:/, ''),
        provider: req.to.replace(/^(provider|system):/, ''),
        model: req.meta.model,
        route: req.meta.route,
        connection: req.meta.connection,
        tokensIn: qty(req, ResourceType.PROMPT_TOKENS),
        tokensOut: qty(e, ResourceType.COMPLETION_TOKENS),
        costUsd: qty(req, ResourceType.COST_USD),
        ms: req.meta.ms,
        status: req.meta.status,
        cached: req.meta.cached,
        stream: req.meta.stream,
        error: req.meta.error,
      };
      this.exchanges.push(ex);
      if (this.exchanges.length > this.maxExchanges) this.exchanges.shift();
      if (ex.connection && !ex.cached) {
        const k = `${ex.connection}:${dayKey(ex.ts)}`;
        this.daily.set(k, (this.daily.get(k) ?? 0) + 1);
      }
    }
  }

  /** Enregistre un échange complet (REQUEST + COMPLETION) et renvoie son résumé. */
  recordExchange(x) {
    const events = exchangeEvents(x);
    const pending = new Map();
    for (const e of events) this._ingest(e, pending);
    this._persist(events);
    return this.exchanges[this.exchanges.length - 1];
  }

  _persist(events) {
    const data = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
    appendFile(this.file, data, { mode: 0o600 }, () => { /* best-effort */ });
    this._writes += 1;
    if (this._writes % 500 === 0) {
      try {
        if (statSync(this.file).size > ROTATE_BYTES) renameSync(this.file, `${this.file}.${Date.now()}`);
      } catch { /* ignore */ }
    }
  }

  dailyCount(connectionId, ts = Date.now()) {
    return this.daily.get(`${connectionId}:${dayKey(ts)}`) ?? 0;
  }

  recent(limit = 100) {
    return this.exchanges.slice(-limit).reverse();
  }

  /** Dépense estimée (USD) depuis `sinceTs`. */
  spendSince(sinceTs) {
    let sum = 0;
    for (let i = this.exchanges.length - 1; i >= 0; i -= 1) {
      const ex = this.exchanges[i];
      if (ex.ts < sinceTs) break;
      sum += ex.costUsd ?? 0;
    }
    return sum;
  }

  /** Requêtes et dépense estimée d'un client (nom de clé) depuis `sinceTs`. */
  clientSince(name, sinceTs) {
    let requests = 0; let costUsd = 0;
    for (let i = this.exchanges.length - 1; i >= 0; i -= 1) {
      const ex = this.exchanges[i];
      if (ex.ts < sinceTs) break;
      if (ex.client === name || ex.client === `mcp:${name}`) { requests += 1; costUsd += ex.costUsd ?? 0; }
    }
    return { requests, costUsd };
  }

  verifyDuality() {
    return checkDuality(this.events);
  }

  /** Agrégats pour le tableau de bord. */
  summary({ sinceMs = 24 * 3600 * 1000 } = {}) {
    const since = Date.now() - sinceMs;
    const total = blank();
    const byProvider = {};
    const byModel = {};
    const byClient = {};
    const byDay = {};
    for (const ex of this.exchanges) {
      if (ex.ts < since) continue;
      add(total, ex);
      add((byProvider[ex.provider] ??= blank()), ex);
      add((byModel[ex.model ?? '?'] ??= blank()), ex);
      add((byClient[ex.client] ??= blank()), ex);
      add((byDay[dayKey(ex.ts)] ??= blank()), ex);
    }
    return { total: fin(total), byProvider: finAll(byProvider), byModel: finAll(byModel), byClient: finAll(byClient), byDay: finAll(byDay) };
  }
}

function blank() {
  return { requests: 0, ok: 0, errors: 0, cached: 0, tokensIn: 0, tokensOut: 0, msSum: 0, costUsd: 0 };
}
function add(a, ex) {
  a.requests += 1;
  if (ex.status === 'ok') a.ok += 1; else a.errors += 1;
  if (ex.cached) a.cached += 1;
  a.tokensIn += ex.tokensIn;
  a.tokensOut += ex.tokensOut;
  if (!ex.cached) a.msSum += ex.ms;
  a.costUsd += ex.costUsd ?? 0;
}
function fin(a) {
  const live = a.requests - a.cached;
  return { ...a, costUsd: Math.round(a.costUsd * 1e6) / 1e6, avgMs: live > 0 ? Math.round(a.msSum / live) : 0 };
}
function finAll(map) {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, fin(v)]));
}
