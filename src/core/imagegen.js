// Copyright (c) 2026 Fido-labs —kcw—
// Génération d'images multi-fournisseurs (/v1/images/generations), gratuits d'abord, avec bascule.
// Adaptateurs : Pollinations (sans clé), compatibles OpenAI (OpenAI, Together, xAI, perso), Gemini,
// Hugging Face, Cloudflare Workers AI, Stability AI, fal.ai (file d'attente), Black Forest Labs, SD WebUI local.
import { randomInt } from 'node:crypto';
import { getProvider, PROVIDERS, endpoint, resolveBaseUrl } from '../providers/registry.js';
import { RouterError, ClientAbort, classify, shortError } from './dispatch.js';
import { estimateTokens } from './chat.js';
import { VERSION } from '../config.js';

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const POLL_MS = 1500;
const POLL_TIMEOUT_MS = 180_000;
const UA = `PhenixRouter/${VERSION}`;

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new ClientAbort()); }, { once: true });
});

function parseSize(size, fallback = '1024x1024') {
  const m = /^(\d{2,4})x(\d{2,4})$/.exec(String(size ?? fallback)) ?? /^(\d{2,4})x(\d{2,4})$/.exec(fallback);
  const clampDim = (v) => Math.min(Math.max(Number(v), 256), 2048);
  return { width: clampDim(m[1]), height: clampDim(m[2]) };
}

function aspectRatio({ width, height }) {
  const r = width / height;
  const options = [['1:1', 1], ['16:9', 16 / 9], ['9:16', 9 / 16], ['4:3', 4 / 3], ['3:4', 3 / 4], ['3:2', 3 / 2], ['2:3', 2 / 3], ['21:9', 21 / 9]];
  return options.sort((a, b) => Math.abs(a[1] - r) - Math.abs(b[1] - r))[0][0];
}

const b64 = (buf) => {
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('image trop volumineuse');
  return buf.toString('base64');
};

async function fetchImageBuffer(f, url, headers, signal) {
  const res = await f(url, { headers: { 'user-agent': UA, ...headers }, signal });
  if (!res.ok) throw new Error(`téléchargement de l'image : HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function jsonOrThrow(res) {
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(shortError(text) || `HTTP ${res.status}`);
    err.status = res.status; err.body = text; err.headers = res.headers;
    throw err;
  }
  try { return JSON.parse(text); } catch { throw new Error('réponse non JSON'); }
}

const bearer = (key, extra = {}) => ({ 'content-type': 'application/json', 'user-agent': UA, ...(key ? { authorization: `Bearer ${key}` } : {}), ...extra });

/* ───────── Adaptateurs : (ctx) → { data:[{b64_json|url}] } ───────── */

const ADAPTERS = {
  async pollinations({ prompt, model, width, height, n, wantUrl, f, signal }) {
    const data = [];
    for (let i = 0; i < n; i += 1) {
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&model=${encodeURIComponent(model || 'flux')}&nologo=true&seed=${randomInt(1, 2 ** 31 - 1)}`;
      if (wantUrl) { data.push({ url }); continue; }
      const res = await f(url, { headers: { 'user-agent': UA }, signal });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      if (!(res.headers.get('content-type') ?? '').startsWith('image/')) throw new Error('réponse non image');
      data.push({ b64_json: b64(Buffer.from(await res.arrayBuffer())) });
    }
    return { data };
  },

  async openai({ provider, conn, key, prompt, model, size, n, body, f, signal }) {
    const req = { model, prompt, n, size };
    for (const k of ['quality', 'style', 'background', 'output_format']) if (body[k]) req[k] = body[k];
    // Les modèles gpt-image-1 renvoient toujours du base64 ; dall-e/Together acceptent response_format.
    if (!/gpt-image/i.test(model)) req.response_format = 'b64_json';
    const json = await jsonOrThrow(await f(endpoint(provider, conn, '/images/generations'), { method: 'POST', headers: bearer(key), body: JSON.stringify(req), signal }));
    const data = (json.data ?? []).map((d) => (d.b64_json ? { b64_json: d.b64_json } : { url: d.url })).filter((d) => d.b64_json || d.url);
    return { data };
  },

  async gemini({ provider, conn, key, prompt, model, f, signal }) {
    const base = (conn.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    const json = await jsonOrThrow(await f(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key, 'user-agent': UA },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'] } }), signal,
    }));
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const data = parts.map((p) => p.inlineData ?? p.inline_data).filter((d) => d?.data).map((d) => ({ b64_json: d.data }));
    if (!data.length) throw new Error('aucune image dans la réponse Gemini (modèle non autorisé sur cette clé ?)');
    return { data };
  },

  async huggingface({ conn, key, prompt, model, f, signal }) {
    const res = await f(`${(conn.baseUrl || 'https://router.huggingface.co/hf-inference').replace(/\/+$/, '')}/models/${model}`, {
      method: 'POST', headers: bearer(key, { accept: 'image/png' }), body: JSON.stringify({ inputs: prompt }), signal,
    });
    if (!res.ok) throw Object.assign(new Error(shortError(await res.text()) || `HTTP ${res.status}`), { status: res.status, headers: res.headers });
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('json')) throw new Error(shortError(await res.text()) || 'réponse JSON inattendue');
    return { data: [{ b64_json: b64(Buffer.from(await res.arrayBuffer())) }] };
  },

  async cloudflare({ conn, key, prompt, model, f, signal }) {
    const acc = encodeURIComponent(conn.extra?.accountId ?? '');
    const res = await f(`${(conn.baseUrl || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '')}/accounts/${acc}/ai/run/${model}`, {
      method: 'POST', headers: bearer(key), body: JSON.stringify({ prompt }), signal,
    });
    const ct = res.headers.get('content-type') ?? '';
    if (res.ok && ct.startsWith('image/')) return { data: [{ b64_json: b64(Buffer.from(await res.arrayBuffer())) }] };
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(shortError(text) || `HTTP ${res.status}`), { status: res.status, headers: res.headers });
    const json = JSON.parse(text);
    const img = json.result?.image;
    if (!img) throw new Error('aucune image dans la réponse Cloudflare');
    return { data: [{ b64_json: img }] };
  },

  async stability({ conn, key, prompt, model, size, width, height, body, f, signal }) {
    const seg = /ultra/i.test(model) ? 'ultra' : /sd3/i.test(model) ? 'sd3' : 'core';
    const form = new FormData();
    form.set('prompt', prompt);
    form.set('output_format', ['jpeg', 'webp'].includes(String(body.output_format)) ? body.output_format : 'png');
    form.set('aspect_ratio', aspectRatio({ width, height }));
    if (body.negative_prompt) form.set('negative_prompt', String(body.negative_prompt));
    if (seg === 'sd3' && /sd3/i.test(model)) form.set('model', model);
    const res = await f(`${(conn.baseUrl || 'https://api.stability.ai').replace(/\/+$/, '')}/v2beta/stable-image/generate/${seg}`, {
      method: 'POST', headers: { authorization: `Bearer ${key}`, accept: 'application/json', 'user-agent': UA }, body: form, signal,
    });
    const json = await jsonOrThrow(res);
    if (!json.image) throw new Error('aucune image dans la réponse Stability');
    return { data: [{ b64_json: json.image }] };
  },

  async fal({ conn, key, prompt, model, width, height, n, f, signal }) {
    const headers = { 'content-type': 'application/json', authorization: `Key ${key}`, 'user-agent': UA };
    const sub = await jsonOrThrow(await f(`${(conn.baseUrl || 'https://queue.fal.run').replace(/\/+$/, '')}/${model}`, { method: 'POST', headers, body: JSON.stringify({ prompt, num_images: n, image_size: { width, height } }), signal }));
    const result = sub.status_url ? await pollJson(f, sub.status_url, sub.response_url, headers, signal, (s) => s.status === 'COMPLETED', (s) => s.status === 'FAILED' && (s.error || 'échec fal.ai')) : sub;
    const images = result.images ?? (result.image ? [result.image] : []);
    if (!images.length) throw new Error('aucune image dans la réponse fal.ai');
    return { data: images.map((i) => ({ url: i.url ?? i })) };
  },

  async bfl({ conn, key, prompt, model, width, height, f, signal }) {
    const headers = { 'content-type': 'application/json', 'x-key': key, accept: 'application/json', 'user-agent': UA };
    const sub = await jsonOrThrow(await f(`${(conn.baseUrl || 'https://api.bfl.ai/v1').replace(/\/+$/, '')}/${encodeURIComponent(model)}`, { method: 'POST', headers, body: JSON.stringify({ prompt, width, height }), signal }));
    if (!sub.polling_url) throw new Error('BFL : URL de suivi absente');
    const result = await pollJson(f, sub.polling_url, null, headers, signal, (s) => s.status === 'Ready', (s) => ['Error', 'Failed', 'Request Moderated', 'Content Moderated'].includes(s.status) && `BFL : ${s.status}`);
    const url = result.result?.sample;
    if (!url) throw new Error('aucune image dans la réponse BFL');
    return { data: [{ url }] };
  },

  async sdwebui({ provider, conn, key, prompt, model, width, height, n, body, f, signal }) {
    const base = resolveBaseUrl(provider, conn);
    const req = { prompt, width, height, batch_size: n, steps: Number(body.steps) || 20, negative_prompt: String(body.negative_prompt ?? '') };
    if (model) req.override_settings = { sd_model_checkpoint: model };
    const json = await jsonOrThrow(await f(`${base}/sdapi/v1/txt2img`, { method: 'POST', headers: bearer(key), body: JSON.stringify(req), signal }));
    const data = (json.images ?? []).map((i) => ({ b64_json: i }));
    if (!data.length) throw new Error('aucune image dans la réponse SD WebUI');
    return { data };
  },
};

async function pollJson(f, statusUrl, resultUrl, headers, signal, done, failed) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS, signal);
    const s = await jsonOrThrow(await f(statusUrl, { headers, signal }));
    const err = failed(s);
    if (err) throw new Error(err);
    if (done(s)) return resultUrl ? jsonOrThrow(await f(resultUrl, { headers, signal })) : s;
  }
  throw new Error('délai de génération dépassé');
}

/** Exporté pour la vidéo (même mécanique d'attente). */
export { pollJson, jsonOrThrow, sleep, fetchImageBuffer };

/* ───────── Orchestration ───────── */

function candidates(gw, requested) {
  const slash = String(requested ?? '').indexOf('/');
  const named = slash > 0 ? getProvider(requested.slice(0, slash)) : null;
  const generic = !requested || ['auto', 'phenix/auto', 'free', 'phenix/free', 'best', 'phenix/best'].includes(requested);
  const rank = (p) => (p.tier === 'paid' ? 1 : 0);
  let list;
  if (named?.image) list = [{ provider: named, model: requested.slice(slash + 1) || named.image.model }];
  else if (generic) list = PROVIDERS.filter((p) => p.image).map((p) => ({ provider: p, model: p.image.model }));
  else {
    // Nom de modèle nu (ex. « flux », « dall-e-3 », « black-forest-labs/FLUX.1-schnell ») : tous les fournisseurs, ce modèle d'abord s'il le semble.
    list = PROVIDERS.filter((p) => p.image).map((p) => ({ provider: p, model: p.image.kind === 'pollinations' ? requested.replace(/^(pollinations|pl)\//i, '') : requested }));
    const preferred = /dall-e|gpt-image/i.test(requested) ? 'openai' : /^flux$/i.test(requested) ? 'pollinations' : /grok/i.test(requested) ? 'xai' : null;
    list = preferred ? list.filter((c) => c.provider.id === preferred) : list.filter((c) => c.provider.id === 'pollinations' || c.provider.id === 'custom' || c.provider.id === 'together' || c.provider.id === 'huggingface' || c.provider.id === 'fal' || c.provider.id === 'bfl');
  }
  const free = generic && /^(free|phenix\/free)$/.test(requested ?? '');
  return list
    .filter((c) => !(free && c.provider.tier === 'paid'))
    .sort((a, b) => rank(a.provider) - rank(b.provider) || a.provider.priority - b.provider.priority);
}

export async function runImages(gw, body, ctx) {
  const prompt = String(body.prompt ?? '').trim().slice(0, 4000);
  if (!prompt) throw new RouterError(400, '« prompt » est requis', 'invalid_request_error');
  const { width, height } = parseSize(body.size);
  const n = Math.min(Math.max(Math.round(Number(body.n) || 1), 1), 4);
  const requested = String(body.model ?? '');
  const wantUrl = body.response_format === 'url';
  const t0 = Date.now();
  const attempts = [];
  const tokensIn = estimateTokens(prompt);

  for (const { provider, model } of candidates(gw, requested)) {
    const reason = gw.costBlock(provider.id);
    if (reason) { attempts.push({ provider: provider.id, skipped: 'cost', message: reason }); continue; }
    const conns = gw.usableConnections(provider.id);
    if (!conns.length) { attempts.push({ provider: provider.id, skipped: 'no_key' }); continue; }
    const adapter = ADAPTERS[provider.image.kind];
    if (!adapter) continue;
    for (const conn of conns) {
      const signal = AbortSignal.any([AbortSignal.timeout(gw.settings().requestTimeoutMs), ...(ctx.signal ? [ctx.signal] : [])]);
      try {
        const out = await adapter({
          gw, provider, conn, key: gw.keyOf(conn), prompt, model, size: body.size, width, height, n, body, wantUrl, signal, f: gw.fetchFor(conn),
        });
        if (!out.data?.length) throw new Error('aucune image reçue');
        const ms = Date.now() - t0;
        gw.health.success(conn.id, ms);
        const served = `${provider.id}/${model || provider.image.kind}`;
        gw.recordExchange({ ts: t0, client: ctx.client, route: 'images', provider: provider.id, model: served, connection: conn.id, status: 'ok', tokensIn, tokensOut: 0, ms });
        return { created: Math.floor(Date.now() / 1000), data: out.data, model: served };
      } catch (e) {
        if (ctx.signal?.aborted || e instanceof ClientAbort) throw new ClientAbort();
        const status = e.status;
        const c = status ? classify(status, e.body ?? e.message, e.headers) : { kind: 'network', retryMs: 0 };
        gw.health.failure(conn.id, c.kind, shortError(e.message), c.retryMs);
        attempts.push({ provider: provider.id, status, kind: c.kind, message: shortError(String(e?.cause?.code ?? e.message)) });
      }
    }
  }
  const real = attempts.filter((a) => !a.skipped);
  gw.recordExchange({ ts: t0, client: ctx.client, route: 'images', provider: real.at(-1)?.provider ?? 'router', model: requested || 'auto', status: 'error', error: 'aucun fournisseur d’images disponible', tokensIn, tokensOut: 0, ms: Date.now() - t0 });
  if (!real.length && attempts.length && attempts.every((a) => a.skipped === 'cost')) {
    throw new RouterError(403, `Fournisseur payant refusé : ${attempts[0].message}`, 'cost_policy', attempts);
  }
  throw new RouterError(
    real.length ? 502 : 503,
    real.length ? `Génération d’image impossible : ${real.at(-1).message}` : 'Aucun fournisseur d’images actif : activez Pollinations (sans clé) ou ajoutez Together, Hugging Face, Cloudflare, fal.ai, Stability, OpenAI…',
    real.length ? 'upstream_unavailable' : 'no_provider', attempts,
  );
}
