// Copyright (c) 2026 Fido-labs —kcw—
// API d'administration du tableau de bord (/api/*) — protégée par session.
import { VERSION, BRAND } from '../config.js';
import { httpError } from '../gateway.js';
import { PROVIDERS, getProvider } from '../providers/registry.js';
import { discoverModels, staticModels } from '../providers/discovery.js';
import { probeConnection } from '../core/dispatch.js';
import { runChat } from '../core/chat.js';
import {
  readJson, sendJson, parseCookies, clientIp,
} from './http.js';
import { sameOrigin } from './v1.js';
import { sseHeaders, sseData } from '../core/sse.js';

const PUBLIC = new Set(['POST /api/login', 'GET /api/session', 'POST /api/logout']);

function cookie(req, value, maxAge) {
  const secure = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `phx_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

async function testConnection(gw, conn) {
  const p = getProvider(conn.provider);
  const t0 = Date.now();
  let error = null;
  let discovered = null;
  if (p.discovery && p.discovery !== 'static') {
    try {
      discovered = await discoverModels(p, conn, gw.keyOf(conn));
    } catch (e) {
      error = e?.cause?.code ?? e?.message ?? String(e);
    }
  }
  if (discovered?.length) {
    gw.health.success(conn.id, Date.now() - t0);
    gw.catalog.refresh({ force: true }).catch(() => {});
    return { ok: true, models: discovered.length, ms: Date.now() - t0 };
  }
  const model = staticModels(p).find((m) => m.tags.includes('chat')) ?? discovered?.[0];
  if (!model) return { ok: false, message: error ?? 'aucun modèle connu pour tester', ms: Date.now() - t0 };
  const r = await probeConnection(gw, conn, model.model);
  if (!r.ok && error && !r.message) r.message = error;
  return r;
}

function providerRows(gw) {
  const conns = gw.connections();
  const catalog = gw.catalog.list();
  const errors = gw.catalog.providerErrors();
  return PROVIDERS.map((p) => ({
    id: p.id, alias: p.alias, name: p.name, note: p.note, signup: p.signup, keyless: !!p.keyless, local: !!p.local,
    custom: !!p.custom, experimental: !!p.experimental, needs: p.needs ?? [], keyEnv: p.keyEnv ?? null, speed: p.speed,
    status: gw.catalog.providerStatus(p.id),
    modelCount: catalog.filter((m) => m.provider === p.id).length,
    discoveryError: errors[p.id] ?? null,
    connections: conns.filter((c) => c.provider === p.id).map((c) => gw.publicConnection(c)),
  }));
}

function overview(gw) {
  const rows = providerRows(gw);
  const catalog = gw.catalog.list();
  return {
    version: VERSION,
    brand: { name: BRAND.name, copyright: BRAND.copyright },
    uptimeSec: Math.round((Date.now() - gw.startedAt) / 1000),
    counts: {
      providersReady: rows.filter((r) => r.status === 'ready').length,
      providersTotal: rows.length,
      modelsReady: catalog.filter((m) => m.status === 'ready').length,
      modelsTotal: catalog.length,
      combos: gw.db.combos.length,
      apiKeys: gw.db.apiKeys.length,
    },
    last24h: gw.ledger.summary({ sinceMs: 24 * 3600 * 1000 }),
    last7d: gw.ledger.summary({ sinceMs: 7 * 24 * 3600 * 1000 }),
    cache: gw.cache.stats(),
    duality: gw.ledger.verifyDuality(),
    catalogUpdatedAt: gw.catalog.updatedAt,
    providers: rows.map((r) => ({
      id: r.id, name: r.name, status: r.status, modelCount: r.modelCount,
      latencyMs: Number.isFinite(gw.providerScore(r.id)) ? gw.providerScore(r.id) : null,
    })),
  };
}

export async function handleAdmin(gw, req, res, url) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const route = `${req.method} ${path}`;
  try {
    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    if (mutating && !sameOrigin(req)) throw httpError(403, 'Origine refusée');

    if (!PUBLIC.has(route)) {
      const ok = gw.verifySession(parseCookies(req).phx_session);
      if (!ok) throw httpError(401, 'Session requise');
    }

    /* ── Session ── */
    if (route === 'POST /api/login') {
      const lim = gw.loginLimiter.hit(`login:${clientIp(req)}`, 8);
      if (!lim.ok) throw httpError(429, `Trop de tentatives. Réessayez dans ${lim.retryAfterSec}s.`);
      const { password } = await readJson(req, 4096);
      if (!password || !gw.checkPassword(String(password))) throw httpError(401, 'Mot de passe incorrect');
      sendJson(res, 200, { ok: true }, { 'set-cookie': cookie(req, gw.issueSession(), 7 * 24 * 3600) });
      return;
    }
    if (route === 'POST /api/logout') {
      sendJson(res, 200, { ok: true }, { 'set-cookie': cookie(req, '', 0) });
      return;
    }
    if (route === 'GET /api/session') {
      sendJson(res, 200, {
        authenticated: gw.verifySession(parseCookies(req).phx_session),
        brand: BRAND.name, version: VERSION, language: gw.settings().language,
      });
      return;
    }
    if (route === 'POST /api/password') {
      const { current, next } = await readJson(req, 4096);
      if (!gw.checkPassword(String(current ?? ''))) throw httpError(401, 'Mot de passe actuel incorrect');
      if (String(next ?? '').length < 8) throw httpError(400, 'Le nouveau mot de passe doit contenir au moins 8 caractères');
      gw.setPassword(String(next));
      sendJson(res, 200, { ok: true });
      return;
    }

    /* ── Vue d'ensemble ── */
    if (route === 'GET /api/overview') { sendJson(res, 200, overview(gw)); return; }
    if (route === 'GET /api/providers') { sendJson(res, 200, { providers: providerRows(gw) }); return; }

    /* ── Connexions ── */
    if (route === 'GET /api/connections') {
      sendJson(res, 200, { connections: gw.connections().map((c) => gw.publicConnection(c)) });
      return;
    }
    if (route === 'POST /api/connections') {
      const conn = gw.addConnection(await readJson(req, 16384));
      sendJson(res, 201, { connection: gw.publicConnection({ ...conn, _key: conn.apiKey ? gw.vault.open(conn.apiKey) : null }) });
      return;
    }
    let m = /^\/api\/connections\/([^/]+)(?:\/(test))?$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (m[2] === 'test' && req.method === 'POST') {
        const conn = gw.connections().find((c) => c.id === id);
        if (!conn) throw httpError(404, 'Connexion introuvable');
        sendJson(res, 200, await testConnection(gw, conn));
        return;
      }
      if (req.method === 'PATCH') {
        if (!gw.updateConnection(id, await readJson(req, 16384))) throw httpError(404, 'Connexion introuvable');
        gw.catalog.refresh({ force: true }).catch(() => {});
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'DELETE') {
        if (id.startsWith('env:') || id.startsWith('auto:')) throw httpError(400, 'Connexion implicite : désactivez-la au lieu de la supprimer');
        if (!gw.deleteConnection(id)) throw httpError(404, 'Connexion introuvable');
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    /* ── Modèles ── */
    if (route === 'GET /api/models') {
      if (url.searchParams.get('refresh') === '1') await gw.catalog.refresh({ force: true });
      else if (gw.catalog.isStale()) gw.catalog.refresh().catch(() => {});
      sendJson(res, 200, { models: gw.catalog.list(), updatedAt: gw.catalog.updatedAt, errors: gw.catalog.providerErrors() });
      return;
    }
    if (route === 'POST /api/models/refresh') {
      await gw.catalog.refresh({ force: true });
      sendJson(res, 200, { ok: true, updatedAt: gw.catalog.updatedAt });
      return;
    }
    if (route === 'POST /api/models/test') {
      const { model } = await readJson(req, 4096);
      if (!model) throw httpError(400, '« model » est requis');
      const t0 = Date.now();
      try {
        // Pas de temperature : on évite le cache pour mesurer un vrai appel.
        const out = await runChat(gw, {
          model, messages: [{ role: 'user', content: 'Réponds par un seul mot : ok' }], max_tokens: 16, stream: false,
        }, { client: 'dashboard-test', route: 'test', requestedModel: model });
        sendJson(res, 200, {
          ok: true, ms: Date.now() - t0, served: out.meta.served,
          reply: String(out.json.choices?.[0]?.message?.content ?? '').slice(0, 200),
        });
      } catch (e) {
        sendJson(res, 200, { ok: false, ms: Date.now() - t0, message: String(e.message ?? e).slice(0, 400), status: e.status ?? 500 });
      }
      return;
    }

    /* ── Combos & alias ── */
    if (route === 'GET /api/combos') { sendJson(res, 200, { combos: gw.listCombos(), aliases: gw.db.aliases }); return; }
    if (route === 'POST /api/combos') { sendJson(res, 201, { combo: gw.upsertCombo(await readJson(req, 16384)) }); return; }
    m = /^\/api\/combos\/([^/]+)$/.exec(path);
    if (m && req.method === 'PUT') { sendJson(res, 200, { combo: gw.upsertCombo({ ...(await readJson(req, 16384)), id: m[1] }) }); return; }
    if (m && req.method === 'DELETE') {
      if (!gw.deleteCombo(m[1])) throw httpError(404, 'Combo introuvable');
      sendJson(res, 200, { ok: true });
      return;
    }
    if (route === 'POST /api/aliases') {
      const { alias, target } = await readJson(req, 4096);
      gw.setAlias(alias, target);
      sendJson(res, 201, { ok: true });
      return;
    }
    m = /^\/api\/aliases\/([^/]+)$/.exec(path);
    if (m && req.method === 'DELETE') {
      if (!gw.deleteAlias(decodeURIComponent(m[1]))) throw httpError(404, 'Alias introuvable');
      sendJson(res, 200, { ok: true });
      return;
    }

    /* ── Clés API clientes ── */
    if (route === 'GET /api/keys') { sendJson(res, 200, { keys: gw.listApiKeys() }); return; }
    if (route === 'POST /api/keys') {
      const body = await readJson(req, 4096);
      const { record, key } = gw.createApiKey(body.name, body);
      sendJson(res, 201, { key, record });
      return;
    }
    m = /^\/api\/keys\/([^/]+)$/.exec(path);
    if (m && req.method === 'PATCH') {
      const r = gw.updateApiKey(m[1], await readJson(req, 4096));
      if (!r) throw httpError(404, 'Clé introuvable');
      sendJson(res, 200, { record: r });
      return;
    }
    if (m && req.method === 'DELETE') {
      if (!gw.deleteApiKey(m[1])) throw httpError(404, 'Clé introuvable');
      sendJson(res, 200, { ok: true });
      return;
    }

    /* ── Réglages, journal, usage ── */
    if (route === 'GET /api/settings') { sendJson(res, 200, { settings: gw.settings() }); return; }
    if (route === 'PUT /api/settings') { sendJson(res, 200, { settings: gw.updateSettings(await readJson(req, 16384)) }); return; }
    if (route === 'GET /api/logs') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 1000);
      sendJson(res, 200, { logs: gw.logs.slice(-limit).reverse(), exchanges: gw.ledger.recent(limit) });
      return;
    }
    if (route === 'GET /api/usage') {
      const hours = Math.min(Math.max(Number(url.searchParams.get('hours')) || 24, 1), 24 * 30);
      sendJson(res, 200, gw.ledger.summary({ sinceMs: hours * 3600 * 1000 }));
      return;
    }
    if (route === 'GET /api/ledger/verify') { sendJson(res, 200, gw.ledger.verifyDuality()); return; }
    if (route === 'POST /api/cache/clear') { gw.cache.clear(); sendJson(res, 200, { ok: true }); return; }
    if (route === 'GET /api/export') {
      sendJson(res, 200, {
        exportedAt: new Date().toISOString(), version: VERSION, settings: gw.settings(),
        combos: gw.db.combos, aliases: gw.db.aliases,
        connections: gw.db.connections.map((c) => ({ provider: c.provider, name: c.name, enabled: c.enabled, baseUrl: c.baseUrl, dailyLimit: c.dailyLimit })),
      }, { 'content-disposition': `attachment; filename="${BRAND.slug}-config.json"` });
      return;
    }

    /* ── Flux d'événements temps réel ── */
    if (route === 'GET /api/events') {
      res.writeHead(200, sseHeaders());
      res.write(sseData({ type: 'hello', version: VERSION }));
      const onEx = (ex) => res.write(sseData({ type: 'exchange', exchange: ex }));
      const onLog = (log) => res.write(sseData({ type: 'log', log }));
      const onCat = () => res.write(sseData({ type: 'catalog' }));
      gw.on('exchange', onEx); gw.on('log', onLog); gw.on('catalog', onCat);
      const hb = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(hb);
        gw.off('exchange', onEx); gw.off('log', onLog); gw.off('catalog', onCat);
      });
      return;
    }

    throw httpError(404, `Route inconnue : ${route}`);
  } catch (e) {
    const status = Number.isInteger(e?.status) ? e.status : 500;
    if (status === 500) gw.log({ level: 'error', message: `admin: ${e?.stack ?? e}` });
    sendJson(res, status, { error: status === 500 ? 'Erreur interne' : String(e.message ?? e) });
  }
}
