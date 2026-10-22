// Copyright (c) 2026 Fido-labs —kcw—
// Catalogue dynamique : fusionne découverte en direct (API des fournisseurs) et repli statique.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDERS, getProvider } from '../providers/registry.js';
import { discoverModels, staticModels } from '../providers/discovery.js';
import { quality } from '../providers/tags.js';
import { priceOf } from '../providers/pricing.js';

export class Catalog {
  constructor(gw) {
    this.gw = gw;
    this.file = join(gw.dir, 'catalog.json');
    this.live = new Map();
    this.refreshing = null;
    this.updatedAt = 0;
    this._load();
  }

  _load() {
    try {
      const json = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const [pid, v] of Object.entries(json.providers ?? {})) this.live.set(pid, v);
      this.updatedAt = json.updatedAt ?? 0;
    } catch { /* premier lancement */ }
  }

  _persist() {
    try {
      writeFileSync(this.file, JSON.stringify({ updatedAt: this.updatedAt, providers: Object.fromEntries(this.live) }), { mode: 0o600 });
    } catch { /* best-effort */ }
  }

  isStale() {
    return Date.now() - this.updatedAt > this.gw.settings().catalogTtlMin * 60_000;
  }

  /**
   * Lance (ou rejoint) un rafraîchissement. Une demande « force » arrivant pendant un
   * rafraîchissement déjà en cours est mise en file d'attente (sinon elle serait perdue :
   * les connexions ont pu changer entre-temps).
   */
  refresh({ force = false } = {}) {
    if (this.refreshing) {
      if (!force) return this.refreshing;
      this.queuedForce ??= this.refreshing
        .catch(() => {})
        .then(() => this._run(true))
        .finally(() => { this.queuedForce = null; });
      return this.queuedForce;
    }
    return this._run(force);
  }

  _run(force) {
    const p = this._refresh(force).finally(() => { if (this.refreshing === p) this.refreshing = null; });
    this.refreshing = p;
    return p;
  }

  async _refresh(force) {
    const ttl = this.gw.settings().catalogTtlMin * 60_000;
    const tasks = PROVIDERS.filter((p) => p.discovery && p.discovery !== 'static').map(async (p) => {
      const conns = this.gw.configuredConnections(p.id);
      if (!conns.length) { this.live.delete(p.id); return; }
      const prev = this.live.get(p.id);
      if (!force && prev && !prev.error && Date.now() - prev.at < ttl) return;
      let lastErr = null;
      for (const conn of conns) {
        try {
          const models = await discoverModels(p, conn, this.gw.keyOf(conn), { fetchFn: this.gw.fetchFor(conn) });
          this.live.set(p.id, { models, at: Date.now(), error: null });
          return;
        } catch (e) {
          lastErr = e;
        }
      }
      // Fournisseur local implicite (Ollama, LM Studio) injoignable : simplement « hors ligne », pas une erreur.
      const quiet = p.local && conns.every((c) => c.implicit);
      this.live.set(p.id, quiet
        ? { models: [], at: Date.now(), error: null, offline: true }
        : { models: prev?.models ?? [], at: Date.now(), error: String(lastErr?.cause?.code ?? lastErr?.message ?? lastErr) });
    });
    await Promise.allSettled(tasks);
    this.updatedAt = Date.now();
    this._persist();
    this.gw.emit('catalog');
  }

  providerStatus(providerId) {
    const configured = this.gw.configuredConnections(providerId);
    if (!configured.length) return 'connect';
    if (this.live.get(providerId)?.offline) return 'offline';
    return this.gw.usableConnections(providerId, { peek: true }).length ? 'ready' : 'cooldown';
  }

  /** Liste plate de tous les modèles connus. */
  list() {
    const out = [];
    for (const p of PROVIDERS) {
      const status = this.providerStatus(p.id);
      const live = this.live.get(p.id);
      const useLive = live?.models?.length && status !== 'connect';
      const models = useLive ? live.models : staticModels(p);
      const score = this.gw.providerScore(p.id);
      const overrides = this.gw.settings().pricing;
      for (const m of models) {
        const price = p.tier === 'paid' ? priceOf(p.id, m.model, overrides) : null;
        out.push({
          id: `${p.id}/${m.model}`,
          provider: p.id,
          providerName: p.name,
          model: m.model,
          name: m.name ?? m.model,
          ctx: m.ctx ?? null,
          tags: m.tags,
          status,
          source: useLive ? 'live' : 'static',
          quality: quality(m.model),
          latencyMs: Number.isFinite(score) ? score : null,
          speed: p.speed,
          tier: p.tier,
          price: price ? { in: price.in, out: price.out, known: price.known } : null,
        });
      }
    }
    return out;
  }

  providerErrors() {
    const out = {};
    for (const [pid, v] of this.live) if (v.error) out[pid] = v.error;
    return out;
  }

  /** Recherche par identifiant « nu » (sans préfixe fournisseur). */
  findBare(name) {
    const n = String(name).toLowerCase();
    return this.list().filter((e) => e.model.toLowerCase() === n || e.model.toLowerCase().endsWith(`/${n}`));
  }
}

export { getProvider };
