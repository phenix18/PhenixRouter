// Copyright (c) 2026 Fido-labs —kcw—
// Test d'une connexion + surveillance de santé périodique (« sonde »).
// La sonde n'utilise que la découverte de modèles (gratuite, sans jetons) : jamais d'appel de génération
// payant en arrière-plan. Une clé révoquée est mise en pause et signalée ; une clé rétablie est réactivée.
import { getProvider } from '../providers/registry.js';
import { discoverModels, staticModels } from '../providers/discovery.js';
import { probeConnection, classify } from './dispatch.js';

const MAX_PER_SWEEP = 25;

/** Test complet d'une connexion (utilisé par le bouton « Tester »). */
export async function testConnection(gw, conn) {
  const p = getProvider(conn.provider);
  if (!p) return { ok: false, message: 'fournisseur inconnu', ms: 0 };
  const t0 = Date.now();
  let error = null;
  let status = null;
  let discovered = null;
  if (p.discovery && p.discovery !== 'static') {
    try {
      discovered = await discoverModels(p, conn, gw.keyOf(conn), { fetchFn: gw.fetchFor(conn) });
    } catch (e) {
      error = e?.cause?.code ?? e?.message ?? String(e);
      status = e?.status ?? null;
    }
  }
  if (discovered?.length) {
    gw.health.success(conn.id, Date.now() - t0);
    gw.catalog.refresh({ force: true }).catch(() => {});
    return { ok: true, models: discovered.length, ms: Date.now() - t0 };
  }
  const model = staticModels(p).find((m) => m.tags.includes('chat')) ?? discovered?.[0];
  if (!model) {
    if (status) { const c = classify(status, '', null); gw.health.failure(conn.id, c.kind === 'client' ? 'server' : c.kind, error, c.retryMs); }
    return { ok: false, status, message: error ?? 'aucun modèle connu pour tester', ms: Date.now() - t0 };
  }
  const r = await probeConnection(gw, conn, model.model);
  if (!r.ok && error && !r.message) r.message = error;
  return r;
}

/** Vérification passive (sans génération) : renvoie { ok:true|false|null, ms, status?, message? }. null = non vérifiable. */
export async function checkConnection(gw, conn) {
  const p = getProvider(conn.provider);
  if (!p || !p.discovery || p.discovery === 'static') return { ok: null, ms: 0, message: 'non vérifiable sans appel de génération' };
  const t0 = Date.now();
  try {
    const list = await discoverModels(p, conn, gw.keyOf(conn), { fetchFn: gw.fetchFor(conn), timeoutMs: 10000 });
    const ms = Date.now() - t0;
    if (!list.length) return { ok: null, ms, message: 'aucun modèle renvoyé' };
    return { ok: true, ms, models: list.length };
  } catch (e) {
    const status = e?.status ?? null;
    return { ok: false, ms: Date.now() - t0, status, message: String(e?.cause?.code ?? e?.message ?? e).slice(0, 200) };
  }
}

export class Monitor {
  constructor(gw) {
    this.gw = gw;
    this.results = new Map();   // id → { at, ok, ms, status, message }
    this.timer = null;
    this.started = false;
    this.running = false;
    this.lastSweepAt = 0;
  }

  get(id) { return this.results.get(id) ?? null; }

  start() { this.started = true; this.configure(); }

  /** (Re)programme la sonde selon le réglage probeIntervalMin (0 = désactivée). */
  configure() {
    clearInterval(this.timer);
    this.timer = null;
    const min = this.gw.settings().probeIntervalMin;
    if (!min) return;
    this.timer = setInterval(() => { this.sweep().catch(() => {}); }, min * 60_000);
    this.timer.unref?.();
  }

  stop() { this.started = false; clearInterval(this.timer); this.timer = null; }

  /** Vérifie les connexions actives qui n'ont pas servi avec succès récemment. */
  async sweep({ force = false } = {}) {
    if (this.running) return [];
    this.running = true;
    const gw = this.gw;
    const out = [];
    try {
      const freshMs = (gw.settings().probeIntervalMin || 30) * 60_000 / 2;
      const conns = gw.connections()
        .filter((c) => c.enabled !== false && !c.implicit && (c._key || getProvider(c.provider)?.keyless || getProvider(c.provider)?.local))
        .filter((c) => force || Date.now() - (gw.health.get(c.id).lastOkAt || 0) > freshMs)
        .slice(0, MAX_PER_SWEEP);
      for (const conn of conns) {
        const r = await checkConnection(gw, conn);
        const before = this.results.get(conn.id);
        const entry = { at: Date.now(), ...r };
        this.results.set(conn.id, entry);
        if (r.ok === true) {
          gw.health.success(conn.id, r.ms);
          if (before?.ok === false) gw.log({ level: 'info', message: `sonde : « ${conn.name} » est de nouveau opérationnelle` });
        } else if (r.ok === false) {
          const c = r.status ? classify(r.status, '', null) : { kind: 'network', retryMs: 0 };
          gw.health.failure(conn.id, c.kind === 'client' ? 'server' : c.kind, r.message, c.retryMs);
          if (before?.ok !== false) gw.alert(`sonde : « ${conn.name} » (${conn.provider}) en échec — ${r.message}${r.status ? ` [HTTP ${r.status}]` : ''}`);
        }
        out.push({ id: conn.id, ...entry });
      }
      this.lastSweepAt = Date.now();
    } finally {
      this.running = false;
    }
    return out;
  }

  status() {
    return { intervalMin: this.gw.settings().probeIntervalMin, running: this.running, lastSweepAt: this.lastSweepAt || null, results: Object.fromEntries(this.results) };
  }
}
