// Copyright (c) 2026 Fido-labs —kcw—
// Audio : transcription / traduction (multipart) et synthèse vocale (JSON → audio) via les
// fournisseurs déclarant `audio` (Groq gratuit pour la transcription, OpenAI payant, endpoint perso).
import { PROVIDERS, getProvider, endpoint } from '../providers/registry.js';
import { classify, shortError, RouterError, ClientAbort } from './dispatch.js';
import { VERSION } from '../config.js';
import { parseMultipart, STT, TTS } from './audioext.js';

const KIND_PATH = { transcriptions: '/audio/transcriptions', translations: '/audio/translations', speech: '/audio/speech' };

/** Lit le champ `model` d'un corps multipart (octets conservés via latin1). */
export function multipartModel(buf) {
  const m = /name="model"\r\n\r\n([^\r\n]*)/.exec(buf.toString('latin1'));
  return m ? m[1].trim() : '';
}

/** Remplace (ou ajoute) le champ `model` d'un corps multipart sans altérer le fichier binaire. */
export function setMultipartModel(buf, boundary, model) {
  const s = buf.toString('latin1');
  const re = /(name="model"\r\n\r\n)([^\r\n]*)/;
  if (re.test(s)) return Buffer.from(s.replace(re, (_, a) => `${a}${model}`), 'latin1');
  const end = `--${boundary}--`;
  const idx = s.lastIndexOf(end);
  if (idx < 0) return buf;
  const part = `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`;
  return Buffer.from(s.slice(0, idx) + part + s.slice(idx), 'latin1');
}

function candidates(gw, kind, requested) {
  const cap = kind === 'speech' ? 'tts' : 'stt';
  const idx = String(requested ?? '').indexOf('/');
  const explicit = idx > 0 ? getProvider(requested.slice(0, idx)) : null;
  const list = explicit ? [explicit] : PROVIDERS.filter((p) => p.audio && (p.custom || p.audio[cap]));
  const rank = (p) => (p.tier === 'paid' ? 1 : 0);
  return list
    .map((p) => ({ provider: p, model: explicit ? requested.slice(idx + 1) : (p.audio[cap] ?? ''), kind: p.audio[`${cap}Kind`] ?? 'openai' }))
    .filter((c) => c.provider.audio && !(kind === 'translations' && c.kind !== 'openai'))
    .sort((a, b) => rank(a.provider) - rank(b.provider) || a.provider.priority - b.provider.priority);
}

/**
 * @param {'transcriptions'|'translations'|'speech'} kind
 * @param {{body: Buffer, contentType: string, client: string, signal?: AbortSignal}} input
 * @returns {Promise<{status:number, contentType:string, body:Buffer, served:string}>}
 */
export async function runAudio(gw, kind, { body, contentType, client, signal }) {
  const isMultipart = /multipart\/form-data/i.test(contentType);
  let requested = '';
  let json = null;
  if (kind === 'speech') {
    try { json = JSON.parse(body.toString('utf8')); } catch { throw new RouterError(400, 'JSON invalide', 'invalid_request_error'); }
    requested = String(json.model ?? '');
    if (!json.input) throw new RouterError(400, '« input » est requis', 'invalid_request_error');
  } else {
    if (!isMultipart) throw new RouterError(400, 'Envoyez un formulaire multipart (champ « file »)', 'invalid_request_error');
    requested = multipartModel(body);
  }
  const boundary = /boundary=("?)([^";]+)\1/i.exec(contentType)?.[2];
  const t0 = Date.now();
  const attempts = [];
  const cands = candidates(gw, kind, requested);

  for (const { provider, model, kind: nativeKind } of cands) {
    const reason = gw.costBlock(provider.id);
    if (reason) { attempts.push({ provider: provider.id, skipped: 'cost', message: reason }); continue; }
    const conns = gw.usableConnections(provider.id);
    if (!conns.length) { attempts.push({ provider: provider.id, skipped: 'no_key' }); continue; }
    for (const conn of conns) {
      if (nativeKind !== 'openai') {
        try {
          const signal2 = AbortSignal.any([AbortSignal.timeout(gw.settings().requestTimeoutMs), ...(signal ? [signal] : [])]);
          const input = { provider, conn, key: gw.keyOf(conn), model, f: gw.fetchFor(conn), signal: signal2 };
          const out = kind === 'speech' ? await TTS[nativeKind]({ ...input, json }) : await STT[nativeKind]({ ...input, mp: parseMultipart(body, contentType) });
          const ms = Date.now() - t0;
          gw.health.success(conn.id, ms);
          const served = `${provider.id}/${model}`;
          gw.recordExchange({ ts: t0, client, route: `audio.${kind}`, provider: provider.id, model: served, connection: conn.id, status: 'ok', tokensIn: kind === 'speech' ? Math.ceil(String(json.input).length / 4) : 0, tokensOut: 0, ms });
          return { status: 200, contentType: out.contentType, body: out.body, served };
        } catch (e) {
          if (signal?.aborted) throw new ClientAbort();
          const c = e.status ? classify(e.status, e.body ?? e.message, e.headers) : { kind: 'network', retryMs: 0 };
          gw.health.failure(conn.id, c.kind, shortError(e.message), c.retryMs);
          attempts.push({ provider: provider.id, status: e.status, kind: c.kind, message: shortError(String(e?.cause?.code ?? e.message)) });
          continue;
        }
      }
      const outBody = kind === 'speech'
        ? JSON.stringify({ ...json, model })
        : (model && boundary ? setMultipartModel(body, boundary, model) : body);
      const headers = {
        'content-type': kind === 'speech' ? 'application/json' : contentType,
        'user-agent': `PhenixRouter/${VERSION}`, ...(provider.extraHeaders ?? {}),
      };
      const key = gw.keyOf(conn);
      if (key) headers.authorization = `Bearer ${key}`;
      try {
        const res = await gw.fetchFor(conn)(endpoint(provider, conn, KIND_PATH[kind]), {
          method: 'POST', headers, body: outBody, signal: AbortSignal.any([AbortSignal.timeout(gw.settings().requestTimeoutMs), ...(signal ? [signal] : [])]),
        });
        const buf = Buffer.from(await res.arrayBuffer());
        if (!res.ok) {
          const text = buf.toString('utf8');
          const c = classify(res.status, text, res.headers);
          gw.health.failure(conn.id, c.kind, shortError(text), c.retryMs);
          attempts.push({ provider: provider.id, status: res.status, kind: c.kind, message: shortError(text) });
          if (!c.switchTarget) throw new RouterError(res.status, shortError(text) || `HTTP ${res.status}`, 'upstream_error', attempts);
          continue;
        }
        const ms = Date.now() - t0;
        gw.health.success(conn.id, ms);
        const served = `${provider.id}/${model}`;
        gw.recordExchange({
          ts: t0, client, route: `audio.${kind}`, provider: provider.id, model: served, connection: conn.id, status: 'ok',
          tokensIn: kind === 'speech' ? Math.ceil(String(json.input).length / 4) : 0, tokensOut: 0, ms,
        });
        return { status: 200, contentType: res.headers.get('content-type') ?? 'application/octet-stream', body: buf, served };
      } catch (e) {
        if (e instanceof RouterError) throw e;
        if (signal?.aborted) throw new ClientAbort();
        gw.health.failure(conn.id, 'network', String(e?.message ?? e));
        attempts.push({ provider: provider.id, kind: 'network', message: String(e?.cause?.code ?? e?.message ?? e).slice(0, 200) });
      }
    }
  }
  const real = attempts.filter((a) => !a.skipped);
  gw.recordExchange({ ts: t0, client, route: `audio.${kind}`, provider: real.at(-1)?.provider ?? 'router', model: requested || kind, status: 'error', error: 'aucun fournisseur audio disponible', tokensIn: 0, tokensOut: 0, ms: Date.now() - t0 });
  if (!real.length && attempts.every((a) => a.skipped === 'cost') && attempts.length) {
    throw new RouterError(403, `Fournisseur payant refusé : ${attempts[0].message}`, 'cost_policy', attempts);
  }
  throw new RouterError(
    real.length ? 502 : 503,
    real.length ? 'Tous les fournisseurs audio ont échoué' : `Aucun fournisseur audio disponible : ajoutez une clé Groq (gratuit, transcription) ou OpenAI dans « Fournisseurs ».`,
    real.length ? 'upstream_unavailable' : 'no_provider', attempts,
  );
}
