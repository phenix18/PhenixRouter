// Copyright (c) 2026 Fido-labs —kcw—
// Gateway : état central (stockage, secrets, connexions, clés API, combos, santé, grand livre).
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  JsonStore, Vault, ensureDir, sha256, randomToken, hashPassword, verifyPassword,
} from './store.js';
import { DEFAULT_SETTINGS, resolveDataDir, clamp } from './config.js';
import { Ledger } from './rea/ledger.js';
import { Health } from './providers/health.js';
import { ResponseCache } from './core/cache.js';
import { RateLimiter } from './core/ratelimit.js';
import { PROVIDERS, getProvider } from './providers/registry.js';
import { Catalog } from './core/catalog.js';
import { VIRTUAL } from './core/router.js';
import { estimateCost } from './providers/pricing.js';
import { fetchViaProxy, parseProxyUrl, maskProxyUrl } from './core/netfetch.js';
import { Tunnel } from './core/tunnel.js';

const COMBO_NAME = /^[a-z0-9][a-z0-9._-]{0,47}$/i;
const RESERVED = new Set([...VIRTUAL, 'phenixrouter-free']);
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

const SETTING_TYPES = {
  language: (v) => (['fr', 'en'].includes(v) ? v : 'fr'),
  requireApiKey: Boolean,
  requestTimeoutMs: (v) => clamp(Number(v) || 120000, 5000, 600000),
  firstByteTimeoutMs: (v) => clamp(Number(v) || 30000, 2000, 300000),
  streamIdleTimeoutMs: (v) => clamp(Number(v) || 60000, 5000, 600000),
  maxAttemptsPerRequest: (v) => clamp(Math.round(Number(v) || 8), 1, 30),
  cacheEnabled: Boolean,
  cacheTtlSec: (v) => clamp(Math.round(Number(v) || 600), 1, 86400),
  cacheMaxEntries: (v) => clamp(Math.round(Number(v) || 200), 0, 5000),
  rateLimitPerMin: (v) => clamp(Math.round(Number(v) || 0), 0, 100000),
  corsOrigins: (v) => (Array.isArray(v) ? v.map(String).filter((o) => /^https?:\/\/|^\*$/.test(o)).slice(0, 50) : []),
  catalogTtlMin: (v) => clamp(Math.round(Number(v) || 30), 1, 1440),
  logRetention: (v) => clamp(Math.round(Number(v) || 500), 50, 5000),
  webTools: Boolean,
  searxngUrl: (v) => (typeof v === 'string' && (v === '' || /^https?:\/\//.test(v)) ? v.replace(/\/+$/, '') : ''),
  autoChainSize: (v) => clamp(Math.round(Number(v) || 6), 1, 20),
  costMode: (v) => (['freeOnly', 'freeFirst', 'any'].includes(v) ? v : 'freeFirst'),
  dailyBudgetUsd: (v) => clamp(Number(v) || 0, 0, 1e6),
  monthlyBudgetUsd: (v) => clamp(Number(v) || 0, 0, 1e7),
  pricing: (v) => {
    const out = {};
    if (v && typeof v === 'object') {
      for (const [k, p] of Object.entries(v).slice(0, 500)) {
        if (p && Number.isFinite(Number(p.in)) && Number.isFinite(Number(p.out))) out[String(k).slice(0, 200)] = { in: clamp(Number(p.in), 0, 1e4), out: clamp(Number(p.out), 0, 1e4) };
      }
    }
    return out;
  },
  tokenSaver: Boolean,
  tokenSaverMaxChars: (v) => clamp(Math.round(Number(v) || 6000), 500, 200000),
  proxyTestUrl: (v) => (typeof v === 'string' && /^https?:\/\//.test(v) ? v : 'https://www.cloudflare.com/cdn-cgi/trace'),
};

export function hasCredentials(conn) {
  const p = getProvider(conn.provider);
  if (!p) return false;
  if (p.custom && !conn.baseUrl) return false;
  if (p.needs?.includes('accountId') && !conn.extra?.accountId) return false;
  if (p.needs?.includes('cx') && !conn.extra?.cx) return false;
  if (p.keyless || p.optionalKey) return true;
  return !!conn._key;
}

export class Gateway extends EventEmitter {
  constructor({ dataDir } = {}) {
    super();
    this.setMaxListeners(100);
    this.dir = resolveDataDir(dataDir);
    ensureDir(this.dir);
    this.vault = new Vault(this.dir);
    this.store = new JsonStore(join(this.dir, 'db.json'), {
      version: 1, connections: [], combos: [], aliases: {}, apiKeys: [], proxies: [], settings: {}, auth: { passwordHash: null },
    });
    this.db = this.store.load();
    this.ledger = new Ledger(this.dir);
    this.health = new Health();
    this.cache = new ResponseCache();
    this.limiter = new RateLimiter();
    this.loginLimiter = new RateLimiter();
    this.logs = [];
    this.rr = new Map();
    this.tunnel = new Tunnel();
    this.proxyHealth = new Map();
    this.proxyRr = 0;
    this.catalog = new Catalog(this);
    this.startedAt = Date.now();
    this._applySettings();
  }

  /* ───────── Réglages ───────── */

  settings() {
    return { ...DEFAULT_SETTINGS, ...this.db.settings };
  }

  _applySettings() {
    const s = this.settings();
    this.cache.configure({ max: s.cacheMaxEntries, ttlMs: s.cacheTtlSec * 1000 });
  }

  updateSettings(patch) {
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (SETTING_TYPES[k]) this.db.settings[k] = SETTING_TYPES[k](v);
    }
    this.store.save();
    this._applySettings();
    return this.settings();
  }

  /* ───────── Authentification du tableau de bord ───────── */

  ensureCredentials() {
    let password = null;
    let apiKey = null;
    if (!this.db.auth.passwordHash) {
      password = process.env.PHENIX_PASSWORD || randomToken(9);
      this.db.auth.passwordHash = hashPassword(password);
      if (!this.db.apiKeys.length) apiKey = this.createApiKey('default').key;
      this.store.flush();
    }
    return { firstRun: !!password, password, apiKey, passwordFromEnv: !!process.env.PHENIX_PASSWORD };
  }

  checkPassword(password) {
    return verifyPassword(password, this.db.auth.passwordHash);
  }

  setPassword(password) {
    this.db.auth.passwordHash = hashPassword(password);
    this.store.flush();
  }

  issueSession() {
    const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS, n: randomToken(6) })).toString('base64url');
    return `${payload}.${this.vault.sign(payload)}`;
  }

  verifySession(token) {
    if (typeof token !== 'string') return false;
    const [payload, sig] = token.split('.');
    if (!payload || !sig || this.vault.sign(payload) !== sig) return false;
    try {
      return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now();
    } catch {
      return false;
    }
  }

  /* ───────── Clés API clientes ───────── */

  createApiKey(name, opts = {}) {
    const key = `phx-${randomToken(24)}`;
    const rec = {
      id: randomUUID(), name: String(name || 'clé').slice(0, 60), hash: sha256(key), prefix: key.slice(0, 8),
      createdAt: Date.now(), lastUsedAt: null, enabled: true,
      rateLimitPerMin: clamp(Math.round(Number(opts.rateLimitPerMin) || 0), 0, 100000),
    };
    this.db.apiKeys.push(rec);
    this.store.save();
    return { record: this.publicApiKey(rec), key };
  }

  publicApiKey(r) {
    const { hash, ...rest } = r;
    return rest;
  }

  listApiKeys() {
    return this.db.apiKeys.map((r) => this.publicApiKey(r));
  }

  updateApiKey(id, patch) {
    const r = this.db.apiKeys.find((k) => k.id === id);
    if (!r) return null;
    if (patch.name != null) r.name = String(patch.name).slice(0, 60);
    if (patch.enabled != null) r.enabled = !!patch.enabled;
    if (patch.rateLimitPerMin != null) r.rateLimitPerMin = clamp(Math.round(Number(patch.rateLimitPerMin) || 0), 0, 100000);
    this.store.save();
    return this.publicApiKey(r);
  }

  deleteApiKey(id) {
    const i = this.db.apiKeys.findIndex((k) => k.id === id);
    if (i === -1) return false;
    this.db.apiKeys.splice(i, 1);
    this.store.save();
    return true;
  }

  verifyApiKey(token) {
    if (!token) return null;
    const envKeys = (process.env.PHENIX_API_KEY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (envKeys.includes(token)) return { id: 'env', name: 'env', rateLimitPerMin: 0 };
    const h = sha256(token);
    const rec = this.db.apiKeys.find((k) => k.hash === h && k.enabled);
    if (!rec) return null;
    if (!rec.lastUsedAt || Date.now() - rec.lastUsedAt > 60_000) {
      rec.lastUsedAt = Date.now();
      this.store.save();
    }
    return rec;
  }

  /* ───────── Connexions fournisseurs ───────── */

  keyOf(conn) {
    return conn._key ?? null;
  }

  /** Toutes les connexions (persistées + issues des variables d'environnement + implicites sans clé). */
  connections() {
    const out = [];
    for (const c of this.db.connections) {
      let key = null;
      try { key = c.apiKey ? this.vault.open(c.apiKey) : null; } catch { key = null; }
      out.push({ ...c, _key: key, readonly: false, implicit: false });
    }
    const disabled = new Set(this.db.settings.disabledImplicit ?? []);
    for (const p of PROVIDERS) {
      if (p.keyEnv && process.env[p.keyEnv]) {
        process.env[p.keyEnv].split(',').map((s) => s.trim()).filter(Boolean).forEach((k, i) => {
          out.push({
            id: `env:${p.id}:${i}`, provider: p.id, name: `${p.keyEnv}${i ? `#${i + 1}` : ''}`,
            enabled: !disabled.has(`env:${p.id}:${i}`), extra: { ...(p.accountEnv ? { accountId: process.env[p.accountEnv] } : {}), ...(p.cxEnv ? { cx: process.env[p.cxEnv] } : {}) },
            dailyLimit: 0, createdAt: this.startedAt, _key: k, readonly: true, implicit: true,
          });
        });
      }
      if (p.keyless && !p.custom) {
        const id = `auto:${p.id}`;
        out.push({
          id, provider: p.id, name: 'automatique (sans clé)', enabled: !disabled.has(id),
          extra: {}, dailyLimit: 0, createdAt: this.startedAt, _key: null, readonly: true, implicit: true,
        });
      }
    }
    return out;
  }

  publicConnection(c) {
    const { _key, apiKey, ...rest } = c;
    return {
      ...rest,
      hasKey: !!_key,
      keyHint: _key ? `…${_key.slice(-4)}` : null,
      usableNow: this.health.available(c.id),
      cooldownLeftMs: this.health.cooldownLeftMs(c.id),
      health: this.health.get(c.id),
      today: this.ledger.dailyCount(c.id),
    };
  }

  addConnection({ provider, name, apiKey, baseUrl, extra, dailyLimit, priority, proxyId }) {
    const p = getProvider(provider);
    if (!p) throw httpError(400, 'Fournisseur inconnu');
    if (p.custom && !/^https?:\/\//.test(baseUrl ?? '')) throw httpError(400, 'URL de base (http/https) requise');
    if (!p.keyless && !p.optionalKey && !apiKey) throw httpError(400, 'Clé API requise');
    if (p.needs?.includes('accountId') && !extra?.accountId) throw httpError(400, 'ID de compte requis');
    if (p.needs?.includes('cx') && !extra?.cx) throw httpError(400, 'Identifiant de moteur (cx) requis');
    const conn = {
      id: randomUUID(), provider: p.id, name: String(name || p.name).slice(0, 60), enabled: true,
      apiKey: apiKey ? this.vault.seal(String(apiKey).trim()) : null,
      baseUrl: baseUrl ? String(baseUrl).replace(/\/+$/, '') : undefined,
      extra: {
        ...(extra?.accountId ? { accountId: String(extra.accountId).trim() } : {}),
        ...(extra?.cx ? { cx: String(extra.cx).trim() } : {}),
      },
      dailyLimit: clamp(Math.round(Number(dailyLimit) || 0), 0, 1e7),
      priority: clamp(Math.round(Number(priority) || 5), 1, 99),
      proxyId: this._validProxyRef(proxyId),
      createdAt: Date.now(),
    };
    this.db.connections.push(conn);
    this.store.save();
    this.catalog.refresh({ force: true }).catch(() => {});
    return conn;
  }

  updateConnection(id, patch) {
    if (id.startsWith('env:') || id.startsWith('auto:')) {
      const set = new Set(this.db.settings.disabledImplicit ?? []);
      if (patch.enabled === false) set.add(id); else set.delete(id);
      this.db.settings.disabledImplicit = [...set];
      this.store.save();
      return true;
    }
    const c = this.db.connections.find((x) => x.id === id);
    if (!c) return null;
    if (patch.name != null) c.name = String(patch.name).slice(0, 60);
    if (patch.enabled != null) c.enabled = !!patch.enabled;
    if (patch.apiKey) c.apiKey = this.vault.seal(String(patch.apiKey).trim());
    if (patch.baseUrl !== undefined) c.baseUrl = patch.baseUrl ? String(patch.baseUrl).replace(/\/+$/, '') : undefined;
    if (patch.extra?.accountId) c.extra = { ...c.extra, accountId: String(patch.extra.accountId).trim() };
    if (patch.extra?.cx) c.extra = { ...c.extra, cx: String(patch.extra.cx).trim() };
    if (patch.dailyLimit != null) c.dailyLimit = clamp(Math.round(Number(patch.dailyLimit) || 0), 0, 1e7);
    if (patch.priority != null) c.priority = clamp(Math.round(Number(patch.priority) || 5), 1, 99);
    if (patch.proxyId !== undefined) c.proxyId = this._validProxyRef(patch.proxyId);
    this.store.save();
    this.health.reset(id);
    return true;
  }

  deleteConnection(id) {
    const i = this.db.connections.findIndex((c) => c.id === id);
    if (i === -1) return false;
    this.db.connections.splice(i, 1);
    this.store.save();
    this.health.reset(id);
    this.catalog.refresh({ force: true }).catch(() => {});
    return true;
  }


  /* ───────── Proxys sortants (pools) ───────── */

  _validProxyRef(ref) {
    if (!ref) return undefined;
    if (ref === 'pool') return 'pool';
    return this.db.proxies.some((p) => p.id === ref) ? String(ref) : undefined;
  }

  publicProxy(p) {
    let masked = '';
    try { masked = maskProxyUrl(this.vault.open(p.url)); } catch { masked = ''; }
    return {
      id: p.id, name: p.name, enabled: p.enabled, createdAt: p.createdAt, url: masked,
      health: this.proxyHealth.get(p.id) ?? null,
      usedBy: this.db.connections.filter((c) => c.proxyId === p.id).length,
    };
  }

  listProxies() {
    return this.db.proxies.map((p) => this.publicProxy(p));
  }

  addProxy({ name, url }) {
    parseProxyUrl(url);
    const rec = { id: randomUUID(), name: String(name || 'proxy').slice(0, 60), url: this.vault.seal(String(url).trim()), enabled: true, createdAt: Date.now() };
    this.db.proxies.push(rec);
    this.store.save();
    return this.publicProxy(rec);
  }

  updateProxy(id, patch) {
    const p = this.db.proxies.find((x) => x.id === id);
    if (!p) return null;
    if (patch.name != null) p.name = String(patch.name).slice(0, 60);
    if (patch.enabled != null) p.enabled = !!patch.enabled;
    if (patch.url) { parseProxyUrl(patch.url); p.url = this.vault.seal(String(patch.url).trim()); }
    this.store.save();
    return this.publicProxy(p);
  }

  deleteProxy(id) {
    const i = this.db.proxies.findIndex((p) => p.id === id);
    if (i === -1) return false;
    this.db.proxies.splice(i, 1);
    for (const c of this.db.connections) if (c.proxyId === id) c.proxyId = undefined;
    this.proxyHealth.delete(id);
    this.store.save();
    return true;
  }

  /** Fonction fetch à utiliser pour une connexion : directe, via un proxy dédié, ou via le pool en rotation. */
  fetchFor(conn) {
    const ref = conn?.proxyId;
    if (!ref) return fetch;
    const live = this.db.proxies.filter((p) => p.enabled);
    let pick = null;
    if (ref === 'pool') {
      const healthy = live.filter((p) => this.proxyHealth.get(p.id)?.ok !== false);
      const list = healthy.length ? healthy : live;
      if (list.length) { pick = list[this.proxyRr % list.length]; this.proxyRr += 1; }
    } else {
      pick = live.find((p) => p.id === ref) ?? null;
    }
    // Échec fermé : si le proxy voulu n'est plus disponible, on NE sort PAS en direct (pas de fuite d'IP).
    if (!pick) return async () => { throw new Error('proxy demandé indisponible (supprimé ou désactivé)'); };
    return async (url, init) => {
      const t0 = Date.now();
      try {
        const res = await fetchViaProxy(this.vault.open(pick.url), url, init);
        this.proxyHealth.set(pick.id, { ok: true, ms: Date.now() - t0, at: Date.now() });
        return res;
      } catch (e) {
        this.proxyHealth.set(pick.id, { ok: false, error: String(e?.message ?? e).slice(0, 200), at: Date.now() });
        throw e;
      }
    };
  }

  /** Teste un proxy : GET sur l'URL de test via ce proxy (renvoie ip/pays si c'est le trace Cloudflare). */
  async testProxy(id) {
    const p = this.db.proxies.find((x) => x.id === id);
    if (!p) return null;
    const url = this.settings().proxyTestUrl;
    const t0 = Date.now();
    try {
      const res = await fetchViaProxy(this.vault.open(p.url), url, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'PhenixRouter' } });
      const text = (await res.text()).slice(0, 2000);
      const ms = Date.now() - t0;
      const ip = /^ip=(.+)$/m.exec(text)?.[1] ?? null;
      const loc = /^loc=(.+)$/m.exec(text)?.[1] ?? null;
      const ok = res.status < 500;
      this.proxyHealth.set(id, ok ? { ok: true, ms, at: Date.now(), ip, loc } : { ok: false, error: `HTTP ${res.status}`, at: Date.now() });
      return { ok, ms, status: res.status, ip, loc };
    } catch (e) {
      const message = String(e?.cause?.code ?? e?.message ?? e).slice(0, 200);
      this.proxyHealth.set(id, { ok: false, error: message, at: Date.now() });
      return { ok: false, ms: Date.now() - t0, message };
    }
  }

  /** Connexions activées et munies d'identifiants, sans tenir compte de la santé. */
  configuredConnections(providerId) {
    return this.connections().filter((c) => c.provider === providerId && c.enabled && hasCredentials(c));
  }

  /**
   * Connexions utilisables maintenant (santé + plafond quotidien), ordonnées en round-robin.
   * @param {{peek?:boolean}} [opts] peek = ne pas faire avancer le curseur.
   */
  usableConnections(providerId, { peek = false } = {}) {
    const list = this.configuredConnections(providerId).filter((c) => (
      this.health.available(c.id) && (!c.dailyLimit || this.ledger.dailyCount(c.id) < c.dailyLimit)
    ));
    if (list.length <= 1) return list;
    // Priorité (1 = d'abord), puis round-robin au sein d'un même niveau de priorité.
    const level = (c) => c.priority ?? 5;
    const best = Math.min(...list.map(level));
    const sorted = [...list].sort((a, b) => level(a) - level(b));
    const top = sorted.filter((c) => level(c) === best);
    const rest = sorted.filter((c) => level(c) !== best);
    const start = (this.rr.get(providerId) ?? 0) % top.length;
    if (!peek) this.rr.set(providerId, start + 1);
    return [...top.slice(start), ...top.slice(0, start), ...rest];
  }

  /* ───────── Gratuit / payant & budgets ───────── */

  /** Dépense estimée (USD) sur le jour UTC courant et le mois UTC courant. */
  spend() {
    const now = new Date();
    const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const month = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    return { day: this.ledger.spendSince(day), month: this.ledger.spendSince(month) };
  }

  /** Raison de refus d'un fournisseur selon le mode de coût et les budgets, ou null s'il est autorisé. */
  costBlock(providerId) {
    const p = getProvider(providerId);
    if (!p || p.tier !== 'paid') return null;
    const s = this.settings();
    if (s.costMode === 'freeOnly') return 'mode « gratuit seul » actif';
    const { day, month } = this.spend();
    if (s.dailyBudgetUsd > 0 && day >= s.dailyBudgetUsd) return `budget quotidien atteint (${day.toFixed(2)} $ / ${s.dailyBudgetUsd} $)`;
    if (s.monthlyBudgetUsd > 0 && month >= s.monthlyBudgetUsd) return `budget mensuel atteint (${month.toFixed(2)} $ / ${s.monthlyBudgetUsd} $)`;
    return null;
  }

  estimateCost(providerId, model, tokensIn, tokensOut) {
    return estimateCost(providerId, model, tokensIn, tokensOut, this.settings().pricing);
  }

  /** Meilleur score de santé parmi les connexions d'un fournisseur (plus bas = meilleur). */
  providerScore(providerId) {
    const conns = this.configuredConnections(providerId);
    if (!conns.length) return Infinity;
    return Math.min(...conns.map((c) => this.health.score(c.id)));
  }

  /* ───────── Combos & alias ───────── */

  listCombos() {
    return this.db.combos;
  }

  upsertCombo({ id, name, models, strategy }) {
    if (!COMBO_NAME.test(name ?? '')) throw httpError(400, 'Nom invalide (lettres, chiffres, . _ - ; 48 max)');
    if (RESERVED.has(String(name).toLowerCase())) throw httpError(400, `« ${name} » est un nom réservé`);
    const list = (Array.isArray(models) ? models : []).map((m) => String(m).trim()).filter(Boolean);
    if (!list.length) throw httpError(400, 'Au moins un modèle est requis');
    const strat = ['fallback', 'roundrobin', 'fastest', 'random'].includes(strategy) ? strategy : 'fallback';
    const dup = this.db.combos.find((c) => c.name.toLowerCase() === String(name).toLowerCase() && c.id !== id);
    if (dup) throw httpError(409, 'Un combo porte déjà ce nom');
    let c = id ? this.db.combos.find((x) => x.id === id) : null;
    if (c) Object.assign(c, { name, models: list, strategy: strat });
    else {
      c = { id: randomUUID(), name, models: list, strategy: strat, createdAt: Date.now() };
      this.db.combos.push(c);
    }
    this.store.save();
    return c;
  }

  deleteCombo(id) {
    const i = this.db.combos.findIndex((c) => c.id === id);
    if (i === -1) return false;
    this.db.combos.splice(i, 1);
    this.store.save();
    return true;
  }

  setAlias(alias, target) {
    if (!COMBO_NAME.test(alias ?? '')) throw httpError(400, 'Alias invalide');
    if (RESERVED.has(String(alias).toLowerCase())) throw httpError(400, 'Alias réservé');
    if (!target) throw httpError(400, 'Cible requise');
    this.db.aliases[alias] = String(target);
    this.store.save();
  }

  deleteAlias(alias) {
    const had = alias in this.db.aliases;
    delete this.db.aliases[alias];
    this.store.save();
    return had;
  }

  /* ───────── Journal & grand livre ───────── */

  log(entry) {
    const e = { ts: Date.now(), ...entry };
    this.logs.push(e);
    const max = this.settings().logRetention;
    if (this.logs.length > max) this.logs.splice(0, this.logs.length - max);
    this.emit('log', e);
    return e;
  }

  recordExchange(x) {
    if (x.costUsd == null && x.status === 'ok' && !x.cached && x.provider) {
      const bare = String(x.model ?? '').startsWith(`${x.provider}/`) ? String(x.model).slice(x.provider.length + 1) : x.model;
      x = { ...x, costUsd: this.estimateCost(x.provider, bare ?? '', x.tokensIn ?? 0, x.tokensOut ?? 0) };
    }
    const ex = this.ledger.recordExchange(x);
    this.emit('exchange', ex);
    return ex;
  }

  close() {
    this.tunnel.stop();
    this.store.flush();
  }
}

export function httpError(status, message, extra = {}) {
  const e = new Error(message);
  e.status = status;
  Object.assign(e, extra);
  return e;
}
