// Copyright (c) 2026 Fido-labs —kcw—
// API de passerelle : /v1/chat/completions, /v1/messages (Anthropic), /v1/responses,
// /v1/models, /v1/embeddings, /v1/images/generations, /v1/search, /v1/web/fetch.
import { once } from 'node:events';
import { BRAND } from '../config.js';
import { httpError } from '../gateway.js';
import {
  readJson, readRaw, sendJson, openaiErrorBody, parseCookies, bearer,
} from './http.js';
import { runChat, estimateTokens, RouterError, ClientAbort } from '../core/chat.js';
import { runEmbeddings, runImages } from '../core/media.js';
import { runAudio } from '../core/audio.js';
import { webSearch, webFetch } from '../core/webtools.js';
import { VIRTUAL } from '../core/router.js';
import {
  sseHeaders, sseData, sseEvent,
} from '../core/sse.js';
import {
  anthropicToOpenAI, openAIToAnthropic, AnthropicStream, anthropicError, ANTHROPIC_ERROR_TYPES,
} from '../core/translate/anthropic.js';
import { responsesToChat, chatToResponses, ResponsesStream } from '../core/translate/responses.js';

export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** Identifie l'appelant : clé API, session du tableau de bord, ou anonyme si autorisé. */
export function authenticate(gw, req) {
  const token = bearer(req);
  const s = gw.settings();
  if (token) {
    const rec = gw.verifyApiKey(token);
    if (rec) return { id: rec.id, name: rec.name, limit: rec.rateLimitPerMin ?? 0 };
    if (!s.requireApiKey) return { id: 'anonymous', name: 'anonymous', limit: 0 };
    throw httpError(401, 'Clé API invalide', { type: 'authentication_error' });
  }
  const cookie = parseCookies(req).phx_session;
  if (cookie && gw.verifySession(cookie) && sameOrigin(req)) return { id: 'dashboard', name: 'dashboard', limit: 0 };
  if (!s.requireApiKey) return { id: 'anonymous', name: 'anonymous', limit: 0 };
  throw httpError(401, 'Clé API manquante (en-tête Authorization: Bearer … ou x-api-key)', { type: 'authentication_error' });
}

function sendError(res, e, anthropic) {
  if (e instanceof ClientAbort || e?.name === 'ClientAbort') {
    if (!res.writableEnded) res.end();
    return;
  }
  const status = Number.isInteger(e?.status) ? e.status : 500;
  const message = status === 500 ? 'Erreur interne du routeur' : String(e.message ?? e);
  const headers = {};
  if (status === 429 && e.retryAfterSec) headers['retry-after'] = String(e.retryAfterSec);
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  if (anthropic) {
    sendJson(res, status, anthropicError(ANTHROPIC_ERROR_TYPES[status] ?? 'api_error', message), headers);
  } else {
    const code = e.type ?? (status === 429 ? 'rate_limit_exceeded' : status === 404 ? 'model_not_found' : null);
    sendJson(res, status, openaiErrorBody(status, message, e.type ?? 'api_error', code, e.attempts ? { attempts: e.attempts } : {}), headers);
  }
}

function servedHeaders(meta) {
  const h = {
    'x-phenix-provider': meta.provider,
    'x-phenix-model': meta.model,
    'x-phenix-attempts': String(meta.attempts ?? 1),
    'x-phenix-cache': meta.cached ? 'hit' : 'miss',
  };
  return h;
}

async function writeSafe(res, data) {
  if (res.destroyed || res.writableEnded) return false;
  if (!res.write(data)) {
    await Promise.race([once(res, 'drain'), once(res, 'close')]).catch(() => {});
  }
  return !res.destroyed;
}

async function pipeStream(res, out, { start = () => [], map, end = () => [], onError, headers = {} }) {
  res.writeHead(200, sseHeaders(headers));
  const hb = setInterval(() => { if (!res.destroyed) res.write(': ping\n\n'); }, 15000);
  hb.unref?.();
  try {
    for (const ev of start()) await writeSafe(res, ev);
    for await (const chunk of out.chunks) {
      for (const ev of map(chunk)) { if (!(await writeSafe(res, ev))) return; }
    }
    for (const ev of end()) await writeSafe(res, ev);
  } catch (e) {
    if (!(e instanceof ClientAbort)) for (const ev of onError(e)) await writeSafe(res, ev);
  } finally {
    clearInterval(hb);
    if (!res.writableEnded) res.end();
  }
}

/* ───────── Handlers ───────── */

async function chatCompletions(gw, req, res, client, ctx) {
  const body = await readJson(req);
  if (!Array.isArray(body.messages) || !body.messages.length) {
    throw httpError(400, '« messages » est requis (tableau non vide)', { type: 'invalid_request_error' });
  }
  const out = await runChat(gw, body, {
    client: client.name, signal: ctx.signal, route: 'chat', requestedModel: body.model ?? 'auto',
  });
  const headers = servedHeaders(out.meta);
  if (out.kind === 'json') { sendJson(res, 200, out.json, headers); return; }
  await pipeStream(res, out, {
    headers,
    map: (chunk) => [sseData(chunk)],
    end: () => [sseData('[DONE]')],
    onError: (e) => [sseData(openaiErrorBody(502, String(e.message ?? e), 'upstream_error')), sseData('[DONE]')],
  });
}

async function anthropicMessages(gw, req, res, client, ctx) {
  const body = await readJson(req);
  if (!body.model || !Array.isArray(body.messages) || !body.messages.length) {
    throw httpError(400, '« model » et « messages » sont requis', { type: 'invalid_request_error' });
  }
  const oa = anthropicToOpenAI(body);
  const out = await runChat(gw, oa, {
    client: client.name, signal: ctx.signal, route: 'messages', requestedModel: body.model, reportRequested: true,
  });
  const headers = servedHeaders(out.meta);
  if (out.kind === 'json') { sendJson(res, 200, openAIToAnthropic(out.json, body.model), headers); return; }
  const tr = new AnthropicStream(body.model, out.tokensInEst);
  await pipeStream(res, out, {
    headers,
    start: () => tr.start(),
    map: (chunk) => tr.push(chunk),
    end: () => tr.end(),
    onError: (e) => [sseEvent('error', anthropicError('api_error', String(e.message ?? e)))],
  });
}

async function responsesApi(gw, req, res, client, ctx) {
  const body = await readJson(req);
  if (!body.model || body.input == null) throw httpError(400, '« model » et « input » sont requis', { type: 'invalid_request_error' });
  const oa = responsesToChat(body);
  const out = await runChat(gw, oa, {
    client: client.name, signal: ctx.signal, route: 'responses', requestedModel: body.model, reportRequested: true,
  });
  const headers = servedHeaders(out.meta);
  if (out.kind === 'json') { sendJson(res, 200, chatToResponses(out.json, body.model, body), headers); return; }
  const tr = new ResponsesStream(body.model, body);
  await pipeStream(res, out, {
    headers,
    start: () => tr.start(),
    map: (chunk) => tr.push(chunk),
    end: () => tr.end(),
    onError: (e) => [sseEvent('error', { type: 'error', message: String(e.message ?? e) })],
  });
}

function listModels(gw, all) {
  const created = Math.floor(gw.startedAt / 1000);
  const data = [];
  const prefix = BRAND.modelPrefix;
  for (const v of VIRTUAL) data.push({ id: `${prefix}/${v}`, object: 'model', created, owned_by: BRAND.slug, kind: 'virtual' });
  for (const c of gw.db.combos) data.push({ id: c.name, object: 'model', created, owned_by: 'combo', kind: 'combo', strategy: c.strategy, models: c.models });
  for (const [alias, target] of Object.entries(gw.db.aliases)) data.push({ id: alias, object: 'model', created, owned_by: 'alias', kind: 'alias', target });
  for (const e of gw.catalog.list()) {
    if (!all && e.status !== 'ready') continue;
    data.push({
      id: e.id, object: 'model', created, owned_by: e.provider, kind: 'model', name: e.name,
      context_length: e.ctx, tags: e.tags, status: e.status, source: e.source,
      free: e.tier !== 'paid', tier: e.tier, ...(e.price ? { pricing_usd_per_mtok: { input: e.price.in, output: e.price.out } } : {}),
    });
  }
  return { object: 'list', data };
}

function countTokens(body) {
  return {
    input_tokens: estimateTokens(body.system) + estimateTokens(body.messages) + estimateTokens(body.tools) + 1,
  };
}

/* ───────── Point d'entrée ───────── */

export async function handleV1(gw, req, res, url, ctx) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const anthropic = path.startsWith('/v1/messages');
  try {
    const client = authenticate(gw, req);
    const lim = gw.limiter.hit(`key:${client.id}`, client.limit || gw.settings().rateLimitPerMin);
    if (!lim.ok) throw httpError(429, 'Limite de requêtes par minute dépassée', { type: 'rate_limit_exceeded', retryAfterSec: lim.retryAfterSec });

    const route = `${req.method} ${path}`;
    switch (route) {
      case 'POST /v1/chat/completions':
        await chatCompletions(gw, req, res, client, ctx); return;
      case 'POST /v1/messages':
        await anthropicMessages(gw, req, res, client, ctx); return;
      case 'POST /v1/messages/count_tokens':
        sendJson(res, 200, countTokens(await readJson(req))); return;
      case 'POST /v1/responses':
        await responsesApi(gw, req, res, client, ctx); return;
      case 'GET /v1/models':
        sendJson(res, 200, listModels(gw, url.searchParams.get('all') === '1')); return;
      case 'POST /v1/embeddings': {
        const body = await readJson(req);
        const { json, served } = await runEmbeddings(gw, body, { client: client.name, signal: ctx.signal });
        sendJson(res, 200, json, { 'x-phenix-model': served }); return;
      }
      case 'POST /v1/audio/transcriptions':
      case 'POST /v1/audio/translations':
      case 'POST /v1/audio/speech': {
        const kind = path.split('/').pop();
        const raw = await readRaw(req);
        const out = await runAudio(gw, kind, { body: raw, contentType: String(req.headers['content-type'] ?? ''), client: client.name, signal: ctx.signal });
        res.writeHead(out.status, { 'content-type': out.contentType, 'content-length': out.body.length, 'x-phenix-model': out.served, 'cache-control': 'no-store' });
        res.end(out.body); return;
      }
      case 'POST /v1/images/generations': {
        const body = await readJson(req);
        sendJson(res, 200, await runImages(gw, body, { client: client.name, signal: ctx.signal })); return;
      }
      case 'GET /v1/search':
      case 'POST /v1/search': {
        if (!gw.settings().webTools) throw httpError(403, 'Outils web désactivés dans les réglages');
        const body = req.method === 'POST' ? await readJson(req) : {};
        const q = body.query ?? body.q ?? url.searchParams.get('q');
        try {
          sendJson(res, 200, await webSearch(gw.settings(), q, { limit: body.limit ?? url.searchParams.get('limit') }));
        } catch (e) {
          throw httpError(502, `Recherche impossible : ${e.message}`);
        }
        return;
      }
      case 'POST /v1/web/fetch': {
        if (!gw.settings().webTools) throw httpError(403, 'Outils web désactivés dans les réglages');
        const body = await readJson(req);
        if (!body.url) throw httpError(400, '« url » est requis', { type: 'invalid_request_error' });
        try {
          sendJson(res, 200, await webFetch(String(body.url), { maxChars: body.max_chars }));
        } catch (e) {
          throw httpError(502, `Lecture impossible : ${e.message}`);
        }
        return;
      }
      default:
        if (req.method === 'GET' && path.startsWith('/v1/models/')) {
          const id = decodeURIComponent(path.slice('/v1/models/'.length));
          const found = listModels(gw, true).data.find((m) => m.id === id);
          if (!found) throw httpError(404, `Modèle « ${id} » introuvable`, { type: 'model_not_found' });
          sendJson(res, 200, found); return;
        }
        throw httpError(404, `Route inconnue : ${req.method} ${path}`, { type: 'invalid_request_error' });
    }
  } catch (e) {
    if (!(e instanceof RouterError) && !e.status && !(e instanceof ClientAbort)) {
      gw.log({ level: 'error', message: `erreur interne: ${e?.stack ?? e}` });
    }
    sendError(res, e, anthropic);
  }
}
