// Copyright (c) 2026 Fido-labs —kcw—
// Embeddings (via les fournisseurs gratuits). Les images vivent dans imagegen.js.
import { resolveTargets } from './router.js';
import { callUpstream, RouterError, ClientAbort } from './dispatch.js';
import { estimateTokens } from './chat.js';

function lastProvider(attempts = []) {
  for (let i = attempts.length - 1; i >= 0; i -= 1) if (attempts[i].provider) return attempts[i].provider;
  return 'router';
}

export async function runEmbeddings(gw, body, ctx) {
  gw.assertModelAllowed(ctx.client, body.model);
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
      path: '/embeddings', body, stream: false, signal: ctx.signal, client: ctx.client,
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
