// Copyright (c) 2026 Fido-labs —kcw—
// Vidéo asynchrone : POST /v1/videos/generations crée un travail, GET /v1/videos/{id} l'interroge.
// Fournisseurs : fal.ai (file d'attente) ; xAI et endpoint personnalisé (même forme /videos/generations).
// L'identifiant renvoyé est SIGNÉ (HMAC) et sans secret : il encode fournisseur, connexion et URL de suivi,
// ce qui rend le suivi sans état et empêche toute URL forgée (pas de SSRF avec nos clés).
import { PROVIDERS, getProvider, resolveBaseUrl } from '../providers/registry.js';
import { RouterError, ClientAbort, classify, shortError } from './dispatch.js';
import { estimateTokens } from './chat.js';
import { jsonOrThrow } from './imagegen.js';
import { VERSION } from '../config.js';

const UA = `PhenixRouter/${VERSION}`;

function sealId(gw, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `vid_${body}.${gw.vault.sign(body)}`;
}

function openId(gw, id) {
  const m = /^vid_([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(String(id));
  if (!m || gw.vault.sign(m[1]) !== m[2]) throw new RouterError(404, 'Identifiant de vidéo invalide', 'not_found');
  try { return JSON.parse(Buffer.from(m[1], 'base64url').toString()); } catch { throw new RouterError(404, 'Identifiant de vidéo invalide', 'not_found'); }
}

const signalFor = (gw, ctx) => AbortSignal.any([AbortSignal.timeout(gw.settings().firstByteTimeoutMs * 2), ...(ctx.signal ? [ctx.signal] : [])]);

const KINDS = {
  fal: {
    async create({ conn, key, model, body, f, signal }) {
      const base = (conn.baseUrl || 'https://queue.fal.run').replace(/\/+$/, '');
      const headers = { 'content-type': 'application/json', authorization: `Key ${key}`, 'user-agent': UA };
      const req = { prompt: body.prompt };
      if (body.image || body.image_url) req.image_url = body.image ?? body.image_url;
      if (body.duration) req.duration = body.duration;
      if (body.aspect_ratio) req.aspect_ratio = body.aspect_ratio;
      const j = await jsonOrThrow(await f(`${base}/${model}`, { method: 'POST', headers, body: JSON.stringify(req), signal }));
      if (!j.status_url || !j.response_url) throw new Error('fal.ai : URL de suivi absente');
      return { ref: { s: j.status_url, r: j.response_url } };
    },
    async poll({ key, ref, f, signal }) {
      const headers = { authorization: `Key ${key}`, 'user-agent': UA };
      const s = await jsonOrThrow(await f(ref.s, { headers, signal }));
      if (s.status === 'FAILED') return { status: 'failed', error: String(s.error ?? 'échec fal.ai') };
      if (s.status !== 'COMPLETED') return { status: s.status === 'IN_QUEUE' ? 'queued' : 'in_progress' };
      const r = await jsonOrThrow(await f(ref.r, { headers, signal }));
      const url = r.video?.url ?? r.videos?.[0]?.url ?? null;
      return url ? { status: 'completed', url } : { status: 'failed', error: 'aucune vidéo dans la réponse' };
    },
  },
  passthrough: {
    async create({ provider, conn, key, model, body, f, signal, action = 'generations' }) {
      const base = resolveBaseUrl(provider, conn);
      const j = await jsonOrThrow(await f(`${base}/videos/${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA, ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ ...body, model }), signal,
      }));
      const id = j.request_id ?? j.id;
      if (!id) throw new Error('identifiant de travail absent');
      return { ref: { q: String(id) } };
    },
    async poll({ provider, conn, key, ref, f, signal }) {
      const base = resolveBaseUrl(provider, conn);
      const j = await jsonOrThrow(await f(`${base}/videos/${encodeURIComponent(ref.q)}`, { headers: { 'user-agent': UA, ...(key ? { authorization: `Bearer ${key}` } : {}) }, signal }));
      const st = String(j.status ?? '').toLowerCase();
      if (['failed', 'error', 'expired'].includes(st)) return { status: 'failed', error: shortError(JSON.stringify(j.error ?? j)) };
      const url = j.video?.url ?? j.url ?? j.data?.[0]?.url ?? null;
      if (url || ['done', 'completed', 'succeeded'].includes(st)) return url ? { status: 'completed', url } : { status: 'failed', error: 'aucune vidéo dans la réponse' };
      return { status: ['queued', 'pending'].includes(st) ? 'queued' : 'in_progress' };
    },
  },
};

function candidates(requested, action) {
  const slash = String(requested ?? '').indexOf('/');
  const named = slash > 0 ? getProvider(requested.slice(0, slash)) : null;
  const ok = (p) => p.video && (action === 'generations' || p.video.kind === 'passthrough');
  if (named?.video && ok(named)) return [{ provider: named, model: requested.slice(slash + 1) || named.video.model }];
  return PROVIDERS.filter(ok).map((p) => ({ provider: p, model: p.video.model }))
    .sort((a, b) => (a.provider.tier === 'paid') - (b.provider.tier === 'paid') || a.provider.priority - b.provider.priority);
}

export async function createVideo(gw, body, ctx, action = 'generations') {
  const prompt = String(body.prompt ?? '').trim().slice(0, 4000);
  if (!prompt && action === 'generations') throw new RouterError(400, '« prompt » est requis', 'invalid_request_error');
  const t0 = Date.now();
  const attempts = [];
  for (const { provider, model } of candidates(String(body.model ?? ''), action)) {
    const reason = gw.costBlock(provider.id);
    if (reason) { attempts.push({ provider: provider.id, skipped: 'cost', message: reason }); continue; }
    const conns = gw.usableConnections(provider.id, { client: ctx.client });
    if (!conns.length) { attempts.push({ provider: provider.id, skipped: 'no_key' }); continue; }
    const kind = KINDS[provider.video.kind];
    for (const conn of conns) {
      try {
        // Un POST de création peut avoir créé le travail même si la réponse échoue : pas de nouvel essai sur la même connexion.
        const { ref } = await kind.create({ provider, conn, key: gw.keyOf(conn), model, body: { ...body, prompt }, f: gw.fetchFor(conn), signal: signalFor(gw, ctx), action });
        const ms = Date.now() - t0;
        gw.health.success(conn.id, ms);
        gw.recordExchange({ ts: t0, client: ctx.client, route: 'videos', provider: provider.id, model: `${provider.id}/${model}`, connection: conn.id, status: 'ok', tokensIn: estimateTokens(prompt), tokensOut: 0, ms });
        const id = sealId(gw, { p: provider.id, c: conn.id, m: model, ...ref });
        return { id, request_id: id, object: 'video', status: 'queued', model: `${provider.id}/${model}`, created: Math.floor(Date.now() / 1000) };
      } catch (e) {
        if (ctx.signal?.aborted) throw new ClientAbort();
        const c = e.status ? classify(e.status, e.body ?? e.message, e.headers) : { kind: 'network', retryMs: 0 };
        gw.health.failure(conn.id, c.kind, shortError(e.message), c.retryMs);
        attempts.push({ provider: provider.id, status: e.status, kind: c.kind, message: shortError(String(e?.cause?.code ?? e.message)) });
      }
    }
  }
  const real = attempts.filter((a) => !a.skipped);
  if (!real.length && attempts.length && attempts.every((a) => a.skipped === 'cost')) throw new RouterError(403, `Fournisseur payant refusé : ${attempts[0].message}`, 'cost_policy', attempts);
  throw new RouterError(
    real.length ? 502 : 503,
    real.length ? `Création de vidéo impossible : ${real.at(-1).message}` : 'Aucun fournisseur vidéo actif : ajoutez une clé fal.ai (ou xAI / endpoint personnalisé) dans « Fournisseurs ».',
    real.length ? 'upstream_unavailable' : 'no_provider', attempts,
  );
}

export async function getVideo(gw, id, ctx) {
  const ref = openId(gw, id);
  const provider = getProvider(ref.p);
  const conn = gw.connections().find((c) => c.id === ref.c);
  if (!provider?.video || !conn) throw new RouterError(404, 'Connexion de ce travail introuvable', 'not_found');
  try {
    const out = await KINDS[provider.video.kind].poll({ provider, conn, key: gw.keyOf(conn), ref, f: gw.fetchFor(conn), signal: signalFor(gw, ctx) });
    return { id, object: 'video', model: `${provider.id}/${ref.m}`, ...out };
  } catch (e) {
    if (ctx.signal?.aborted) throw new ClientAbort();
    throw new RouterError(502, `Suivi de la vidéo impossible : ${shortError(e.message)}`, 'upstream_unavailable');
  }
}
