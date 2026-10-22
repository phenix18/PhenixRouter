// Copyright (c) 2026 Fido-labs —kcw—
// Appel amont avec bascule automatique : rotation des clés, coupe-circuit, repli entre
// modèles. Détecte aussi les erreurs « 200 avec corps d'erreur » et les flux vides.
import { VERSION } from '../config.js';
import { getProvider, chatEndpoint, endpoint } from '../providers/registry.js';
import { parseRetryAfter } from '../providers/health.js';
import { openaiChunks, DONE, StreamError } from './sse.js';

export class RouterError extends Error {
  constructor(status, message, type = 'router_error', attempts = [], extra = {}) {
    super(message);
    this.name = 'RouterError';
    this.status = status;
    this.type = type;
    this.attempts = attempts;
    Object.assign(this, extra);
  }
}

export class ClientAbort extends Error {
  constructor() {
    super('client_aborted');
    this.name = 'ClientAbort';
  }
}

const UNSUPPORTED = /(tool|function|image|vision|multimodal|modalit|response_format|json_schema|stream_options|unsupported|not support|does not support|invalid parameter|unrecognized|unknown (field|parameter)|context|too long|maximum|max_tokens|reduce the length)/i;
const MODEL_MISSING = /(model.{0,40}(not found|does not exist|unavailable|not available|decommission|deprecated)|no such model|unknown model|invalid model)/i;

function prepareBody(provider, body, model) {
  const b = { ...body, model };
  for (const k of Object.keys(b)) if (b[k] === undefined || b[k] === null) delete b[k];
  for (const k of provider.dropParams ?? []) delete b[k];
  if (!b.stream) delete b.stream_options;
  return b;
}

export function classify(status, text, headers) {
  const lower = text.toLowerCase();
  const retryMs = parseRetryAfter(headers, text);
  if (status === 429) {
    const daily = /(per day|daily|quota|exhaust|billing|credits?|monthly)/.test(lower);
    return { kind: daily ? 'quota' : 'rate', retryMs, switchTarget: true };
  }
  if (status === 402) return { kind: 'quota', retryMs, switchTarget: true };
  if (status === 401 || status === 403) return { kind: 'auth', retryMs, switchTarget: true };
  if (status === 404 || (status === 400 && MODEL_MISSING.test(lower))) return { kind: 'client', retryMs, switchTarget: true, skipProvider: true };
  if (status === 408 || status === 425 || status >= 500) return { kind: 'server', retryMs, switchTarget: true };
  if (status === 400 || status === 413 || status === 422) {
    return { kind: 'client', retryMs, switchTarget: UNSUPPORTED.test(lower), skipProvider: false };
  }
  return { kind: 'client', retryMs, switchTarget: false };
}

export function shortError(text) {
  try {
    const j = JSON.parse(text);
    return String(j?.error?.message ?? j?.message ?? j?.error ?? text).slice(0, 240);
  } catch {
    return String(text).replace(/\s+/g, ' ').slice(0, 240);
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new StreamError(label, 'network')), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

async function send(gw, provider, conn, model, spec) {
  const s = gw.settings();
  const url = spec.path === '/chat/completions' ? chatEndpoint(provider, conn) : endpoint(provider, conn, spec.path);
  const headers = {
    'content-type': 'application/json',
    accept: spec.stream ? 'text/event-stream' : 'application/json',
    'user-agent': `PhenixRouter/${VERSION}`,
    ...(provider.extraHeaders ?? {}),
  };
  const key = gw.keyOf(conn);
  if (key) headers.authorization = `Bearer ${key}`;

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(new ClientAbort());
  if (spec.signal?.aborted) throw new ClientAbort();
  spec.signal?.addEventListener('abort', onAbort, { once: true });
  const cleanup = () => spec.signal?.removeEventListener('abort', onAbort);

  const headerTimer = setTimeout(() => ctrl.abort(new Error('délai de première réponse dépassé')), s.firstByteTimeoutMs);
  try {
    const res = await gw.fetchFor(conn)(url, {
      method: 'POST', headers, body: JSON.stringify(prepareBody(provider, spec.body, model)), signal: ctrl.signal,
    });
    return { res, ctrl, cleanup, totalMs: s.requestTimeoutMs };
  } catch (e) {
    cleanup();
    if (spec.signal?.aborted) throw new ClientAbort();
    throw e;
  } finally {
    clearTimeout(headerTimer);
  }
}

/** Test ciblé d'UNE connexion (sans bascule) : requête minimale, renvoie ok/latence/erreur. */
export async function probeConnection(gw, conn, model) {
  const provider = getProvider(conn.provider);
  if (!provider) return { ok: false, message: 'fournisseur inconnu', ms: 0 };
  const t0 = Date.now();
  try {
    const sent = await send(gw, provider, conn, model, {
      path: '/chat/completions', stream: false,
      body: { messages: [{ role: 'user', content: 'Réponds uniquement : ok' }], max_tokens: 8, temperature: 0 },
    });
    const text = await sent.res.text();
    sent.cleanup();
    const ms = Date.now() - t0;
    if (!sent.res.ok) {
      const c = classify(sent.res.status, text, sent.res.headers);
      gw.health.failure(conn.id, c.kind, shortError(text), c.retryMs);
      return { ok: false, status: sent.res.status, message: shortError(text) || `HTTP ${sent.res.status}`, ms };
    }
    gw.health.success(conn.id, ms);
    return { ok: true, ms };
  } catch (e) {
    const message = e?.cause?.code ?? e?.message ?? String(e);
    gw.health.failure(conn.id, 'network', message);
    return { ok: false, message: String(message), ms: Date.now() - t0 };
  }
}

/**
 * @param {import('../gateway.js').Gateway} gw
 * @param {Array<{provider:string, model:string}>} targets
 * @param {{path:string, body:object, stream?:boolean, signal?:AbortSignal, validate?:(json:any)=>boolean}} spec
 */
export async function callUpstream(gw, targets, spec) {
  const settings = gw.settings();
  const attempts = [];
  let tried = 0;
  let lastClient = null;

  let blocked = null;
  outer:
  for (const target of targets) {
    const provider = getProvider(target.provider);
    if (!provider) continue;
    const costReason = gw.costBlock(provider.id);
    if (costReason) {
      blocked ??= costReason;
      attempts.push({ provider: provider.id, model: target.model, skipped: 'cost', message: costReason });
      continue;
    }
    const conns = gw.usableConnections(provider.id);
    if (!conns.length) {
      attempts.push({ provider: provider.id, model: target.model, skipped: gw.configuredConnections(provider.id).length ? 'cooldown' : 'no_key' });
      continue;
    }
    for (const conn of conns) {
      if (tried >= settings.maxAttemptsPerRequest) break outer;
      tried += 1;
      const t0 = Date.now();
      const rec = { provider: provider.id, model: target.model, connection: conn.name };
      let sent;
      try {
        sent = await send(gw, provider, conn, target.model, spec);
      } catch (e) {
        if (e instanceof ClientAbort || e?.name === 'ClientAbort') throw new ClientAbort();
        const msg = e?.cause?.code ?? e?.message ?? String(e);
        gw.health.failure(conn.id, 'network', msg);
        attempts.push({ ...rec, kind: 'network', message: String(msg).slice(0, 200) });
        continue;
      }
      const { res, ctrl, cleanup } = sent;

      if (!res.ok) {
        let text = '';
        try { text = await res.text(); } catch { /* ignore */ }
        cleanup();
        const c = classify(res.status, text, res.headers);
        const message = shortError(text) || `HTTP ${res.status}`;
        gw.health.failure(conn.id, c.kind, message, c.retryMs);
        attempts.push({ ...rec, status: res.status, kind: c.kind, message });
        if (!c.switchTarget) {
          throw new RouterError(res.status, message, 'upstream_error', attempts, { upstreamStatus: res.status });
        }
        if (c.kind === 'client') lastClient = { status: res.status, message };
        if (c.skipProvider) continue outer;
        continue;
      }

      try {
        if (spec.stream) {
          const iter = openaiChunks(res.body, { idleMs: settings.streamIdleTimeoutMs })[Symbol.asyncIterator]();
          const first = await withTimeout(iter.next(), settings.firstByteTimeoutMs, 'aucun octet reçu du flux');
          if (first.done || first.value === DONE) throw new StreamError('flux vide', 'server');
          const ttfb = Date.now() - t0;
          gw.health.success(conn.id, ttfb);
          async function* chunks() {
            try {
              yield first.value;
              for (;;) {
                const n = await iter.next();
                if (n.done || n.value === DONE) return;
                yield n.value;
              }
            } finally {
              cleanup();
              ctrl.abort(new ClientAbort());
              try { await iter.return?.(); } catch { /* ignore */ }
            }
          }
          return { kind: 'stream', chunks: chunks(), provider, conn, model: target.model, ttfbMs: ttfb, attempts, abort: () => ctrl.abort(new ClientAbort()) };
        }

        const total = setTimeout(() => ctrl.abort(new Error('délai total dépassé')), sent.totalMs);
        let text;
        try { text = await res.text(); } finally { clearTimeout(total); cleanup(); }
        let json;
        try { json = JSON.parse(text); } catch { throw new StreamError('réponse non JSON', 'server'); }
        if (json?.error && !(json.choices || json.data)) throw new StreamError(shortError(JSON.stringify(json)), 'server');
        if (spec.validate && !spec.validate(json)) throw new StreamError('réponse vide ou invalide', 'server');
        const ms = Date.now() - t0;
        gw.health.success(conn.id, ms);
        return { kind: 'json', json, provider, conn, model: target.model, ms, attempts };
      } catch (e) {
        cleanup();
        try { ctrl.abort(new ClientAbort()); } catch { /* ignore */ }
        if (spec.signal?.aborted) throw new ClientAbort();
        const kind = e instanceof StreamError ? e.kind : 'network';
        const message = String(e?.message ?? e).slice(0, 240);
        gw.health.failure(conn.id, kind, message);
        attempts.push({ ...rec, kind, message });
      }
    }
  }

  const real = attempts.filter((a) => !a.skipped);
  if (!real.length && blocked && attempts.every((a) => a.skipped === 'cost')) {
    throw new RouterError(
      403,
      `Fournisseur payant refusé : ${blocked}. Changez le mode de coût dans les réglages ou demandez un modèle gratuit (phenix/free).`,
      'cost_policy', attempts,
    );
  }
  if (!real.length) {
    const noKey = attempts.some((a) => a.skipped === 'no_key');
    throw new RouterError(
      503,
      attempts.length
        ? `Aucun fournisseur disponible (${noKey ? 'clé manquante' : 'en pause après erreurs'}). Ajoutez une clé (gratuite ou payante) dans le tableau de bord.`
        : 'Aucun modèle ne correspond à la demande. Vérifiez le nom du modèle ou ajoutez un fournisseur.',
      'no_provider', attempts,
    );
  }
  const limited = real.every((a) => a.kind === 'rate' || a.kind === 'quota');
  if (lastClient && real.every((a) => a.kind === 'client')) {
    throw new RouterError(lastClient.status, lastClient.message, 'upstream_error', attempts);
  }
  const summary = real.map((a) => `${a.provider}/${a.model}: ${a.status ?? a.kind}${a.message ? ` (${a.message.slice(0, 80)})` : ''}`).join(' ; ');
  throw new RouterError(
    limited ? 429 : 502,
    `Tous les fournisseurs ont échoué après ${real.length} tentative(s) — ${summary}`,
    limited ? 'rate_limit_exceeded' : 'upstream_unavailable',
    attempts,
  );
}
