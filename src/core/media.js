// Copyright (c) 2026 Fido-labs —kcw—
// Embeddings (via les fournisseurs gratuits) et génération d'images (Pollinations, sans clé).
import { randomInt } from 'node:crypto';
import { resolveTargets } from './router.js';
import { callUpstream, RouterError, ClientAbort } from './dispatch.js';
import { estimateTokens } from './chat.js';
import { VERSION } from '../config.js';

function lastProvider(attempts = []) {
  for (let i = attempts.length - 1; i >= 0; i -= 1) if (attempts[i].provider) return attempts[i].provider;
  return 'router';
}

export async function runEmbeddings(gw, body, ctx) {
  if (body.input == null || body.input === '' || (Array.isArray(body.input) && !body.input.length)) {
    throw new RouterError(400, '« input » est requis', 'invalid_request_error');
  }
  const requested = body.model || 'embed';
  const resolved = resolveTargets(gw, requested, { kind: 'embedding' });
  const t0 = Date.now();
  const tokensInEst = estimateTokens(body.input);
  let result;
  try {
    result = await callUpstream(gw, resolved.targets, {
      path: '/embeddings', body, stream: false, signal: ctx.signal,
      validate: (j) => Array.isArray(j.data) && j.data.length > 0,
    });
  } catch (e) {
    if (e instanceof ClientAbort) throw e;
    gw.recordExchange({
      ts: t0, client: ctx.client, route: 'embeddings', provider: lastProvider(e.attempts), model: requested,
      status: 'error', error: e.message, tokensIn: tokensInEst, tokensOut: 0, ms: Date.now() - t0,
    });
    throw e;
  }
  const served = `${result.provider.id}/${result.model}`;
  const json = result.json;
  json.model = resolved.kind === 'explicit' ? requested : served;
  gw.recordExchange({
    ts: t0, client: ctx.client, route: 'embeddings', provider: result.provider.id, model: served, connection: result.conn.id,
    status: 'ok', tokensIn: json.usage?.prompt_tokens ?? tokensInEst, tokensOut: 0, ms: result.ms,
  });
  return { json, served };
}

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export async function runImages(gw, body, ctx) {
  const prompt = String(body.prompt ?? '').trim().slice(0, 2000);
  if (!prompt) throw new RouterError(400, '« prompt » est requis', 'invalid_request_error');
  const conns = gw.usableConnections('pollinations');
  if (!conns.length) {
    throw new RouterError(503, 'La génération d’images utilise Pollinations (sans clé) : activez-le dans Fournisseurs.', 'no_provider');
  }
  const m = /^(\d{2,4})x(\d{2,4})$/.exec(String(body.size ?? '1024x1024'));
  const width = Math.min(Math.max(Number(m?.[1] ?? 1024), 256), 2048);
  const height = Math.min(Math.max(Number(m?.[2] ?? 1024), 256), 2048);
  const n = Math.min(Math.max(Math.round(Number(body.n) || 1), 1), 4);
  let model = String(body.model ?? '').replace(/^(pollinations|pl)\//i, '');
  if (!model || ['auto', 'phenix/auto'].includes(model)) model = 'flux';
  const wantUrl = body.response_format === 'url';
  const conn = conns[0];
  const t0 = Date.now();

  const data = [];
  try {
    for (let i = 0; i < n; i += 1) {
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&model=${encodeURIComponent(model)}&nologo=true&seed=${randomInt(1, 2 ** 31 - 1)}`;
      if (wantUrl) { data.push({ url }); continue; }
      const res = await fetch(url, { headers: { 'user-agent': `PhenixRouter/${VERSION}` }, signal: ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!(res.headers.get('content-type') ?? '').startsWith('image/')) throw new Error('réponse non image');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_IMAGE_BYTES) throw new Error('image trop volumineuse');
      data.push({ b64_json: buf.toString('base64') });
    }
  } catch (e) {
    if (ctx.signal?.aborted) throw new ClientAbort();
    gw.health.failure(conn.id, 'network', e.message);
    gw.recordExchange({
      ts: t0, client: ctx.client, route: 'images', provider: 'pollinations', model: `pollinations/${model}`,
      status: 'error', error: e.message, tokensIn: estimateTokens(prompt), tokensOut: 0, ms: Date.now() - t0,
    });
    throw new RouterError(502, `Génération d’image impossible : ${e.message}`, 'upstream_unavailable');
  }
  const ms = Date.now() - t0;
  gw.health.success(conn.id, ms);
  gw.recordExchange({
    ts: t0, client: ctx.client, route: 'images', provider: 'pollinations', model: `pollinations/${model}`, connection: conn.id,
    status: 'ok', tokensIn: estimateTokens(prompt), tokensOut: 0, ms,
  });
  return { created: Math.floor(Date.now() / 1000), data };
}
