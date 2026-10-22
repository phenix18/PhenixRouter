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
import { runEmbeddings } from '../core/media.js';
import { runImages } from '../core/imagegen.js';
import { createVideo, getVideo } from '../core/video.js';
import { runSearch, runFetch } from '../core/webproviders.js';
import { runAudio } from '../core/audio.js';
import { VIRTUAL } from '../core/router.js';
import { listByType, modelInfo } from '../core/modeltypes.js';
import { listVoices } from '../core/audioext.js';
import { PROVIDERS } from '../providers/registry.js';
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

export function servedHeaders(meta) {
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

export async function pipeStream(res, out, { start = () => [], map, end = () => [], onError, headers = {} }) {
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

export function listModels(gw, all) {
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
    if (req.method === 'POST') { const qb = gw.clientBlock(client.name); if (qb) throw httpError(qb.status, qb.message, { type: qb.type }); }

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
      case 'GET /v1/models/image': case 'GET /v1/models/video': case 'GET /v1/models/tts': case 'GET /v1/models/stt':
      case 'GET /v1/models/embedding': case 'GET /v1/models/web': case 'GET /v1/models/image-to-text': case 'GET /v1/models/vision':
        sendJson(res, 200, listByType(gw, path.split('/').pop(), url.searchParams.get('all') === '1')); return;
      case 'GET /v1/models/chat': case 'GET /v1/models/llm':
        sendJson(res, 200, listModels(gw, url.searchParams.get('all') === '1')); return;
      case 'GET /v1/models':
        sendJson(res, 200, listModels(gw, url.searchParams.get('all') === '1')); return;
      case 'GET /v1/models/info': {
        const id = url.searchParams.get('id') ?? '';
        const info = modelInfo(gw, id) ?? listModels(gw, true).data.find((m) => m.id === id);
        if (!info) throw httpError(404, `Modèle « ${id} » introuvable`, { type: 'model_not_found' });
        sendJson(res, 200, info); return;
      }
      case 'GET /v1/audio/voices': {
        const pid = url.searchParams.get('provider') ?? 'elevenlabs';
        const p = PROVIDERS.find((x) => x.id === pid || x.alias === pid);
        const kind = p?.audio?.ttsKind;
        if (!kind) throw httpError(400, `« ${pid} » ne propose pas de liste de voix`, { type: 'invalid_request_error' });
        const conn = gw.usableConnections(p.id, { peek: true })[0];
        if (!conn) throw httpError(503, `Aucune clé active pour « ${p.id} »`, { type: 'no_provider' });
        const voices = await listVoices(kind, { conn, key: gw.keyOf(conn), f: gw.fetchFor(conn), signal: AbortSignal.timeout(15000) }).catch((e) => { throw httpError(502, `Voix indisponibles : ${e.message}`); });
        sendJson(res, 200, { object: 'list', data: voices }); return;
      }
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
        if (kind === 'speech' && url.searchParams.get('response_format') === 'json') {
          const format = /mpeg|mp3/.test(out.contentType) ? 'mp3' : /wav/.test(out.contentType) ? 'wav' : /ogg|opus/.test(out.contentType) ? 'ogg' : 'mp3';
          sendJson(res, 200, { audio: out.body.toString('base64'), format }, { 'x-phenix-model': out.served }); return;
        }
        res.writeHead(out.status, { 'content-type': out.contentType, 'content-length': out.body.length, 'x-phenix-model': out.served, 'cache-control': 'no-store' });
        res.end(out.body); return;
      }
      case 'POST /v1/images/generations': {
        const body = await readJson(req);
        const binary = url.searchParams.get('response_format') === 'binary';
        const out = await runImages(gw, binary ? { ...body, response_format: 'b64_json' } : body, { client: client.name, signal: ctx.signal });
        if (binary) {
          let first = out.data[0];
          let buf = first?.b64_json ? Buffer.from(first.b64_json, 'base64') : null;
          if (!buf && first?.url) {
            const r = await fetch(first.url, { signal: AbortSignal.timeout(60000) });
            if (!r.ok) throw httpError(502, `Téléchargement de l'image impossible (HTTP ${r.status})`);
            buf = Buffer.from(await r.arrayBuffer());
          }
          if (!buf) throw httpError(502, 'Aucune image reçue');
          const mime = buf.subarray(0, 3).toString('hex') === 'ffd8ff' ? 'image/jpeg' : buf.subarray(0, 4).toString('latin1') === 'RIFF' ? 'image/webp' : 'image/png';
          res.writeHead(200, { 'content-type': mime, 'content-length': buf.length, 'x-phenix-model': out.model ?? '', 'cache-control': 'no-store' });
          res.end(buf); return;
        }
        sendJson(res, 200, out); return;
      }
      case 'POST /v1/videos/generations':
      case 'POST /v1/videos/edits':
      case 'POST /v1/videos/extensions': {
        const body = await readJson(req);
        sendJson(res, 202, await createVideo(gw, body, { client: client.name, signal: ctx.signal }, path.split('/').pop())); return;
      }
      case 'GET /v1/search':
      case 'POST /v1/search': {
        if (!gw.settings().webTools) throw httpError(403, 'Outils web désactivés dans les réglages');
        const body = req.method === 'POST' ? await readJson(req) : Object.fromEntries(url.searchParams);
        sendJson(res, 200, await runSearch(gw, body, { client: client.name, signal: ctx.signal })); return;
      }
      case 'POST /v1/web/fetch': {
        if (!gw.settings().webTools) throw httpError(403, 'Outils web désactivés dans les réglages');
        sendJson(res, 200, await runFetch(gw, await readJson(req), { client: client.name, signal: ctx.signal })); return;
      }
      default:
        if (req.method === 'GET' && path.startsWith('/v1/videos/')) {
          sendJson(res, 200, await getVideo(gw, decodeURIComponent(path.slice('/v1/videos/'.length)), { signal: ctx.signal })); return;
        }
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
