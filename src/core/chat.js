// Copyright (c) 2026 Fido-labs —kcw—
// Orchestration d'une requête de chat : résolution, cache, appel amont, comptabilité REA.
import { resolveTargets } from './router.js';
import { callUpstream, RouterError, ClientAbort } from './dispatch.js';
import { ResponseCache } from './cache.js';

export const estimateTokens = (value) => {
  if (value == null) return 0;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil(s.length / 4);
};

function hasImages(messages = []) {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p?.type === 'image_url'));
}

function lastProvider(attempts) {
  for (let i = attempts.length - 1; i >= 0; i -= 1) if (attempts[i].provider) return attempts[i].provider;
  return 'router';
}

/**
 * @param {import('../gateway.js').Gateway} gw
 * @param {object} body  requête au format OpenAI Chat Completions
 * @param {{client:string, signal?:AbortSignal, route:string, requestedModel:string, reportRequested?:boolean}} ctx
 */
export async function runChat(gw, body, ctx) {
  const settings = gw.settings();
  const stream = !!body.stream;
  const needTools = !!body.tools?.length;
  const needVision = hasImages(body.messages);
  const resolved = resolveTargets(gw, body.model, { needTools, needVision });
  const tokensInEst = estimateTokens(body.messages) + estimateTokens(body.tools);
  const t0 = Date.now();

  const display = (served) => (ctx.reportRequested || resolved.kind === 'explicit' ? ctx.requestedModel : served);
  const base = { ts: t0, client: ctx.client, route: ctx.route, stream };

  const cacheable = !stream && settings.cacheEnabled && body.temperature === 0;
  const cacheKey = cacheable ? ResponseCache.key({ m: ctx.requestedModel, b: { ...body, stream: undefined } }) : null;
  if (cacheKey) {
    const hit = gw.cache.get(cacheKey);
    if (hit) {
      gw.recordExchange({
        ...base, provider: hit.meta.provider, model: hit.meta.served, cached: true, status: 'ok',
        tokensIn: hit.json.usage?.prompt_tokens ?? tokensInEst, tokensOut: hit.json.usage?.completion_tokens ?? 0, ms: 0,
      });
      return { kind: 'json', json: hit.json, meta: { ...hit.meta, cached: true } };
    }
  }

  let result;
  try {
    result = await callUpstream(gw, resolved.targets, {
      path: '/chat/completions', body, stream, signal: ctx.signal,
      validate: (j) => Array.isArray(j.choices) && j.choices.length > 0,
    });
  } catch (e) {
    if (e instanceof ClientAbort) throw e;
    gw.recordExchange({
      ...base, provider: lastProvider(e.attempts ?? []), model: ctx.requestedModel, status: 'error', error: e.message,
      tokensIn: tokensInEst, tokensOut: 0, ms: Date.now() - t0,
    });
    gw.log({ level: 'error', route: ctx.route, model: ctx.requestedModel, message: e.message, attempts: e.attempts });
    throw e;
  }

  const served = `${result.provider.id}/${result.model}`;
  const shown = display(served);
  const meta = {
    provider: result.provider.id, model: result.model, served, connection: result.conn.name,
    connectionId: result.conn.id, kind: resolved.kind, requested: ctx.requestedModel,
    attempts: result.attempts.length + 1, cached: false,
  };
  const exchange = {
    ...base, provider: result.provider.id, model: served, connection: result.conn.id,
  };

  if (result.kind === 'json') {
    const json = result.json;
    json.model = shown;
    const text = json.choices?.[0]?.message?.content ?? '';
    const calls = json.choices?.[0]?.message?.tool_calls;
    const usage = json.usage ?? {
      prompt_tokens: tokensInEst,
      completion_tokens: estimateTokens(text) + estimateTokens(calls),
    };
    json.usage = { ...usage, total_tokens: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens };
    gw.recordExchange({
      ...exchange, status: 'ok', tokensIn: usage.prompt_tokens ?? tokensInEst, tokensOut: usage.completion_tokens ?? 0, ms: result.ms,
    });
    gw.log({ level: 'info', route: ctx.route, model: served, ms: result.ms, message: 'ok' });
    if (cacheKey) gw.cache.set(cacheKey, { json, meta });
    return { kind: 'json', json, meta };
  }

  async function* wrapped() {
    let outChars = 0;
    let usage = null;
    let failed = null;
    let delivered = false;
    try {
      for await (const chunk of result.chunks) {
        if (chunk.usage) usage = chunk.usage;
        const d = chunk.choices?.[0]?.delta;
        if (d?.content) outChars += d.content.length;
        if (d?.tool_calls) outChars += JSON.stringify(d.tool_calls).length;
        chunk.model = shown;
        delivered = true;
        yield chunk;
      }
    } catch (e) {
      failed = e;
      gw.health.failure(result.conn.id, 'network', e?.message ?? String(e));
      throw e;
    } finally {
      gw.recordExchange({
        ...exchange,
        status: failed && !delivered ? 'error' : 'ok',
        error: failed?.message,
        tokensIn: usage?.prompt_tokens ?? tokensInEst,
        tokensOut: usage?.completion_tokens ?? Math.ceil(outChars / 4),
        ms: Date.now() - t0,
      });
      gw.log({ level: failed ? 'warn' : 'info', route: ctx.route, model: served, ms: Date.now() - t0, message: failed ? `flux interrompu : ${failed.message}` : 'ok (flux)' });
    }
  }

  return { kind: 'stream', chunks: wrapped(), meta: { ...meta, ttfbMs: result.ttfbMs }, tokensInEst };
}

export { RouterError, ClientAbort };
