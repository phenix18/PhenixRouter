// Copyright (c) 2026 Fido-labs —kcw—
// API Gemini native : /v1beta/models[/{m}][:generateContent|:streamGenerateContent|:countTokens|:embedContent|:batchEmbedContents]
// Auth : en-tête x-goog-api-key, ?key=… ou Authorization: Bearer.
import { httpError } from '../gateway.js';
import { readJson, sendJson } from './http.js';
import { authenticate, pipeStream, servedHeaders, listModels } from './v1.js';
import { runChat, estimateTokens, RouterError, ClientAbort } from '../core/chat.js';
import { runEmbeddings } from '../core/media.js';
import { sseHeaders } from '../core/sse.js';
import { geminiToOpenAI, openAIToGemini, GeminiStream, geminiError } from '../core/translate/gemini.js';

const stripModels = (id) => String(id).replace(/^models\//, '');

function modelEntry(m) {
  const embed = m.tags?.includes('embedding');
  return {
    name: `models/${m.id}`, displayName: m.name ?? m.id, description: `via PhenixRouter (${m.owned_by})`, version: 'router',
    inputTokenLimit: m.context_length ?? 32768, outputTokenLimit: 8192,
    supportedGenerationMethods: embed ? ['embedContent', 'batchEmbedContents'] : ['generateContent', 'streamGenerateContent', 'countTokens'],
  };
}

const textOf = (content) => (content?.parts ?? []).map((p) => p.text ?? '').join('');

export async function handleGemini(gw, req, res, url, ctx) {
  const path = url.pathname.replace(/\/+$/, '');
  try {
    if (!req.headers['x-goog-api-key'] && !req.headers.authorization && url.searchParams.get('key')) req.headers['x-goog-api-key'] = url.searchParams.get('key');
    const client = authenticate(gw, req);
    const lim = gw.limiter.hit(`key:${client.id}`, client.limit || gw.settings().rateLimitPerMin);
    if (!lim.ok) throw httpError(429, 'Limite de requêtes par minute dépassée', { retryAfterSec: lim.retryAfterSec });
    if (req.method === 'POST') { const qb = gw.clientBlock(client.name); if (qb) throw httpError(qb.status, qb.message, { type: qb.type }); }

    if (req.method === 'GET' && path === '/v1beta/models') {
      sendJson(res, 200, { models: listModels(gw, false).data.map(modelEntry) }); return;
    }
    const m = /^\/v1beta\/models\/(.+?)(?::(\w+))?$/.exec(path);
    if (!m) throw httpError(404, `Route inconnue : ${req.method} ${path}`);
    const model = stripModels(decodeURIComponent(m[1]));
    const action = m[2];

    if (req.method === 'GET' && !action) {
      const found = listModels(gw, true).data.find((x) => x.id === model);
      if (!found) throw httpError(404, `Modèle « ${model} » introuvable`);
      sendJson(res, 200, modelEntry(found)); return;
    }
    if (req.method !== 'POST') throw httpError(405, 'Méthode non autorisée');
    const body = await readJson(req);

    if (action === 'generateContent' || action === 'streamGenerateContent') {
      if (!Array.isArray(body.contents) || !body.contents.length) throw httpError(400, '« contents » est requis');
      const stream = action === 'streamGenerateContent';
      const out = await runChat(gw, geminiToOpenAI(body, model, stream), { client: client.name, signal: ctx.signal, route: 'gemini', requestedModel: model, reportRequested: true });
      const headers = servedHeaders(out.meta);
      if (out.kind === 'json') { sendJson(res, 200, openAIToGemini(out.json, model), headers); return; }
      const tr = new GeminiStream(model);
      await pipeStream(res, out, {
        headers, map: (chunk) => tr.push(chunk), end: () => tr.end(),
        onError: (e) => [`data: ${JSON.stringify(geminiError(502, String(e.message ?? e)))}\n\n`],
      });
      return;
    }
    if (action === 'countTokens') {
      const total = estimateTokens(body.contents ?? body.generateContentRequest?.contents ?? []) + estimateTokens(body.systemInstruction ?? '');
      sendJson(res, 200, { totalTokens: total }); return;
    }
    if (action === 'embedContent' || action === 'batchEmbedContents') {
      const reqs = action === 'embedContent' ? [body] : body.requests ?? [];
      const input = reqs.map((r) => textOf(r.content));
      if (!input.length || input.some((t) => !t)) throw httpError(400, '« content.parts[].text » est requis');
      const { json } = await runEmbeddings(gw, { model, input }, { client: client.name, signal: ctx.signal });
      const vectors = json.data.map((d) => ({ values: d.embedding }));
      sendJson(res, 200, action === 'embedContent' ? { embedding: vectors[0] } : { embeddings: vectors }); return;
    }
    throw httpError(404, `Méthode inconnue : ${action ?? '(aucune)'}`);
  } catch (e) {
    if (e instanceof ClientAbort || e?.name === 'ClientAbort') { if (!res.writableEnded) res.end(); return; }
    if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
    const status = Number.isInteger(e?.status) ? e.status : 500;
    if (status === 500) gw.log({ level: 'error', message: `gemini: ${e?.stack ?? e}` });
    sendJson(res, status, geminiError(status, status === 500 ? 'Erreur interne du routeur' : String(e.message ?? e)), status === 429 && e.retryAfterSec ? { 'retry-after': String(e.retryAfterSec) } : {});
  }
}
