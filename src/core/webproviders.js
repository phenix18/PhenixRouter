// Copyright (c) 2026 Fido-labs —kcw—
// /v1/search et /v1/web/fetch multi-fournisseurs : Tavily, Brave, Serper, Linkup, Google PSE, Exa,
// Firecrawl, Jina Reader (sans clé), + repli intégré gratuit (SearXNG / DuckDuckGo + Wikipédia / lecture directe).
// Forme de réponse alignée sur FlagshipRouter (results[], citation, usage, metrics ; data.title/content),
// avec les anciens champs conservés pour compatibilité.
import { PROVIDERS, getProvider } from '../providers/registry.js';
import { RouterError, ClientAbort, classify, shortError } from './dispatch.js';
import { webSearch, webFetch } from './webtools.js';
import { jsonOrThrow } from './imagegen.js';
import { VERSION } from '../config.js';

const UA = `PhenixRouter/${VERSION}`;
const clampN = (v, lo, hi, d) => Math.min(Math.max(Math.round(Number(v)) || d, lo), hi);
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

function norm(provider, items, now) {
  return items.filter((r) => r.url).map((r, i) => ({
    title: String(r.title ?? '').slice(0, 300), url: r.url, display_url: host(r.url) + (() => { try { return new URL(r.url).pathname.replace(/\/$/, ''); } catch { return ''; } })(),
    snippet: String(r.snippet ?? '').slice(0, 1000), source: provider, position: i + 1, score: r.score ?? null,
    published_at: r.published_at ?? null, favicon_url: null, content: r.content ?? null,
    metadata: { author: r.author ?? null, language: null, source_type: null, image_url: null },
    citation: { provider, retrieved_at: now, rank: i + 1 },
  }));
}

const base = (conn, def) => (conn.baseUrl || def).replace(/\/+$/, '');
const jsonHeaders = (extra) => ({ 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA, ...extra });

/* ───────── Recherche : (ctx) → { items, answer? } ───────── */

const SEARCH = {
  async tavily({ conn, key, q, max, body, f, signal }) {
    const req = { query: q, max_results: max, search_depth: body.search_depth ?? 'basic', topic: body.search_type === 'news' ? 'news' : 'general' };
    if (body.time_range) req.time_range = body.time_range;
    if (Array.isArray(body.domain_filter)) req.include_domains = body.domain_filter;
    if (body.include_answer) req.include_answer = true;
    const j = await jsonOrThrow(await f(`${base(conn, 'https://api.tavily.com')}/search`, { method: 'POST', headers: jsonHeaders({ authorization: `Bearer ${key}` }), body: JSON.stringify(req), signal }));
    return { items: (j.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content, score: r.score, published_at: r.published_date })), answer: j.answer ?? null };
  },
  async brave({ conn, key, q, max, body, f, signal }) {
    const params = new URLSearchParams({ q, count: String(Math.min(max, 20)) });
    if (body.country) params.set('country', String(body.country));
    if (body.language) params.set('search_lang', String(body.language));
    const j = await jsonOrThrow(await f(`${base(conn, 'https://api.search.brave.com/res/v1')}/web/search?${params}`, { headers: { accept: 'application/json', 'x-subscription-token': key, 'user-agent': UA }, signal }));
    return { items: (j.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: String(r.description ?? '').replace(/<[^>]+>/g, ''), published_at: r.page_age })) };
  },
  async serper({ conn, key, q, max, body, f, signal }) {
    const news = body.search_type === 'news';
    const j = await jsonOrThrow(await f(`${base(conn, 'https://google.serper.dev')}/${news ? 'news' : 'search'}`, { method: 'POST', headers: jsonHeaders({ 'x-api-key': key }), body: JSON.stringify({ q, num: max, ...(body.country ? { gl: body.country } : {}), ...(body.language ? { hl: body.language } : {}) }), signal }));
    return { items: (j[news ? 'news' : 'organic'] ?? []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet, published_at: r.date ?? null })), answer: j.answerBox?.answer ?? j.answerBox?.snippet ?? null };
  },
  async linkup({ conn, key, q, max, f, signal }) {
    const j = await jsonOrThrow(await f(`${base(conn, 'https://api.linkup.so/v1')}/search`, { method: 'POST', headers: jsonHeaders({ authorization: `Bearer ${key}` }), body: JSON.stringify({ q, depth: 'standard', outputType: 'searchResults' }), signal }));
    return { items: (j.results ?? []).slice(0, max).map((r) => ({ title: r.name ?? r.title, url: r.url, snippet: r.content })) };
  },
  async 'google-pse'({ conn, key, q, max, f, signal }) {
    const params = new URLSearchParams({ key, cx: conn.extra?.cx ?? '', q, num: String(Math.min(max, 10)) });
    const j = await jsonOrThrow(await f(`${base(conn, 'https://www.googleapis.com/customsearch/v1')}?${params}`, { headers: { accept: 'application/json', 'user-agent': UA }, signal }));
    return { items: (j.items ?? []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet })) };
  },
  async exa({ conn, key, q, max, body, f, signal }) {
    const req = { query: q, numResults: max, contents: { text: { maxCharacters: 1500 } } };
    if (body.search_type === 'news') req.category = 'news';
    if (Array.isArray(body.domain_filter)) req.includeDomains = body.domain_filter;
    const j = await jsonOrThrow(await f(`${base(conn, 'https://api.exa.ai')}/search`, { method: 'POST', headers: jsonHeaders({ 'x-api-key': key }), body: JSON.stringify(req), signal }));
    return { items: (j.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: String(r.text ?? '').slice(0, 300), content: r.text ?? null, score: r.score, published_at: r.publishedDate, author: r.author })) };
  },
};

/* ───────── Lecture : (ctx) → { title, content, url } ───────── */

const clip = (s, n) => (n > 0 ? String(s ?? '').slice(0, n) : String(s ?? ''));

const FETCH = {
  async tavily({ conn, key, url, max, f, signal }) {
    const j = await jsonOrThrow(await f(`${base(conn, 'https://api.tavily.com')}/extract`, { method: 'POST', headers: jsonHeaders({ authorization: `Bearer ${key}` }), body: JSON.stringify({ urls: [url] }), signal }));
    const r = j.results?.[0];
    if (!r) throw new Error(j.failed_results?.[0]?.error ?? 'aucun contenu extrait');
    return { title: '', content: clip(r.raw_content, max), url: r.url ?? url };
  },
  async exa({ conn, key, url, max, f, signal }) {
    const j = await jsonOrThrow(await f(`${base(conn, 'https://api.exa.ai')}/contents`, { method: 'POST', headers: jsonHeaders({ 'x-api-key': key }), body: JSON.stringify({ urls: [url], text: true }), signal }));
    const r = j.results?.[0];
    if (!r) throw new Error('aucun contenu extrait');
    return { title: r.title ?? '', content: clip(r.text, max), url: r.url ?? url };
  },
  async firecrawl({ conn, key, url, max, f, signal }) {
    const j = await jsonOrThrow(await f(`${base(conn, 'https://api.firecrawl.dev/v1')}/scrape`, { method: 'POST', headers: jsonHeaders({ authorization: `Bearer ${key}` }), body: JSON.stringify({ url, formats: ['markdown'] }), signal }));
    if (!j.success && !j.data) throw new Error(j.error ?? 'échec Firecrawl');
    return { title: j.data?.metadata?.title ?? '', content: clip(j.data?.markdown, max), url: j.data?.metadata?.sourceURL ?? url };
  },
};

/** Jina Reader : sans clé (la clé, si présente, relève les limites). Le service tiers voit l'URL demandée. */
async function jinaReader({ conn, key, url, max, f, signal }) {
  const headers = { accept: 'application/json', 'x-return-format': 'markdown', 'user-agent': UA, ...(key ? { authorization: `Bearer ${key}` } : {}) };
  const j = await jsonOrThrow(await f(`${base(conn ?? {}, 'https://r.jina.ai')}/${url}`, { headers, signal }));
  return { title: j.data?.title ?? '', content: clip(j.data?.content, max), url: j.data?.url ?? url };
}

/* ───────── Orchestration ───────── */

const GENERIC = new Set(['', 'auto', 'search-combo', 'fetch-combo', 'phenix/auto', 'search', 'fetch']);

function wanted(body) {
  const raw = String(body.provider ?? body.model ?? '').toLowerCase().replace(/\/(search|fetch)$/, '');
  return GENERIC.has(raw) ? null : raw;
}

function chain(gw, cap, name) {
  const list = PROVIDERS.filter((p) => p[cap]).filter((p) => !name || p.id === name || p.alias === name);
  return list.sort((a, b) => (a.tier === 'paid') - (b.tier === 'paid') || a.priority - b.priority);
}

async function tryProviders(gw, cap, table, input, ctx, name) {
  const attempts = [];
  for (const provider of chain(gw, cap, name)) {
    const reason = gw.costBlock(provider.id);
    if (reason) { attempts.push({ provider: provider.id, skipped: 'cost', message: reason }); continue; }
    const conns = gw.usableConnections(provider.id);
    if (!conns.length) { attempts.push({ provider: provider.id, skipped: 'no_key' }); continue; }
    for (const conn of conns) {
      const signal = AbortSignal.any([AbortSignal.timeout(20000), ...(ctx.signal ? [ctx.signal] : [])]);
      const t0 = Date.now();
      try {
        const out = await table[provider[cap].kind]({ ...input, provider, conn, key: gw.keyOf(conn), f: gw.fetchFor(conn), signal });
        gw.health.success(conn.id, Date.now() - t0);
        return { provider, conn, out, ms: Date.now() - t0, attempts };
      } catch (e) {
        if (ctx.signal?.aborted) throw new ClientAbort();
        const c = e.status ? classify(e.status, e.body ?? e.message, e.headers) : { kind: 'network', retryMs: 0 };
        gw.health.failure(conn.id, c.kind, shortError(e.message), c.retryMs);
        attempts.push({ provider: provider.id, status: e.status, kind: c.kind, message: shortError(String(e?.cause?.code ?? e.message)) });
      }
    }
  }
  return { attempts };
}

export async function runSearch(gw, body, ctx) {
  const q = String(body.query ?? body.q ?? '').trim().slice(0, 400);
  if (!q) throw new RouterError(400, '« query » est requis', 'invalid_request_error');
  const max = clampN(body.max_results ?? body.limit, 1, 20, 5);
  const name = wanted(body);
  if (name && !PROVIDERS.some((p) => p.search && (p.id === name || p.alias === name)) && !['duckduckgo', 'builtin', 'searxng', 'wikipedia'].includes(name)) {
    throw new RouterError(400, `Fournisseur de recherche inconnu : « ${name} »`, 'invalid_request_error');
  }
  const now = new Date().toISOString();
  const t0 = Date.now();
  let res = ['duckduckgo', 'builtin', 'searxng', 'wikipedia'].includes(name ?? '') ? { attempts: [] } : await tryProviders(gw, 'search', SEARCH, { q, max, body }, ctx, name);
  let provider = res.provider?.id;
  let upstreamMs = res.ms;
  let items; let answer = null;
  if (res.out) { items = res.out.items; answer = res.out.answer ?? null; } else {
    if (name && !['duckduckgo', 'builtin', 'searxng', 'wikipedia'].includes(name)) {
      const real = res.attempts.filter((a) => !a.skipped);
      if (!real.length && res.attempts.every((a) => a.skipped === 'cost') && res.attempts.length) throw new RouterError(403, `Fournisseur payant refusé : ${res.attempts[0].message}`, 'cost_policy', res.attempts);
      throw new RouterError(real.length ? 502 : 503, real.length ? `Recherche impossible : ${real.at(-1).message}` : `Aucune clé active pour « ${name} » : ajoutez-la dans « Fournisseurs ».`, real.length ? 'upstream_unavailable' : 'no_provider', res.attempts);
    }
    const tb = Date.now();
    try {
      const fb = await webSearch(gw.settings(), q, { limit: max });
      items = fb.results; provider = fb.backend; upstreamMs = Date.now() - tb;
    } catch (e) {
      throw new RouterError(502, `Recherche impossible : ${shortError(e.message)}`, 'upstream_unavailable', res.attempts);
    }
  }
  items = items.slice(0, max);
  gw.recordExchange({ ts: t0, client: ctx.client, route: 'search', provider: provider ?? 'builtin', model: `${provider}/search`, connection: res.conn?.id, status: 'ok', tokensIn: Math.ceil(q.length / 4), tokensOut: 0, ms: Date.now() - t0 });
  return {
    provider, query: q, results: norm(provider, items, now), answer,
    usage: { queries_used: 1, search_cost_usd: null },
    metrics: { response_time_ms: Date.now() - t0, upstream_latency_ms: upstreamMs ?? null, total_results_available: items.length },
  };
}

export async function runFetch(gw, body, ctx) {
  const url = String(body.url ?? '').trim();
  if (!/^https?:\/\//i.test(url)) throw new RouterError(400, '« url » (http/https) est requis', 'invalid_request_error');
  const format = ['markdown', 'text', 'html'].includes(body.format) ? body.format : 'markdown';
  const max = body.max_characters === 0 ? 0 : clampN(body.max_characters ?? body.max_chars, 500, 200000, 20000);
  const name = wanted(body);
  const t0 = Date.now();
  const direct = ['direct', 'builtin', 'local'].includes(name ?? '');
  const reader = ['jina', 'jina-reader', 'reader'].includes(name ?? '');
  let provider; let data;
  if (!direct && !reader) {
    const res = await tryProviders(gw, 'fetch', FETCH, { url, max }, ctx, name);
    if (res.out) { provider = res.provider.id; data = res.out; } else if (name) {
      const real = res.attempts.filter((a) => !a.skipped);
      throw new RouterError(real.length ? 502 : 503, real.length ? `Lecture impossible : ${real.at(-1).message}` : `Aucune clé active pour « ${name} ».`, real.length ? 'upstream_unavailable' : 'no_provider', res.attempts);
    }
  }
  if (!data && reader) {
    try { data = await jinaReader({ conn: {}, key: gw.connections().find((c) => c.provider === 'jina' && c.enabled)?._key, url, max, f: fetch, signal: AbortSignal.timeout(25000) }); provider = 'jina-reader'; } catch (e) { throw new RouterError(502, `Lecture impossible : ${shortError(e.message)}`, 'upstream_unavailable'); }
  }
  if (!data) {
    // Lecture directe intégrée (garde SSRF : aucune adresse privée).
    try {
      const w = await webFetch(url, { maxChars: max || 100000 });
      data = { title: w.title, content: w.text, url: w.url, truncated: w.truncated, contentType: w.contentType, status: w.status };
      provider = 'direct';
    } catch (e) { throw new RouterError(502, `Lecture impossible : ${shortError(e.message)}`, 'upstream_unavailable'); }
  }
  gw.recordExchange({ ts: t0, client: ctx.client, route: 'fetch', provider, model: `${provider}/fetch`, status: 'ok', tokensIn: 0, tokensOut: 0, ms: Date.now() - t0 });
  const content = data.content ?? '';
  return {
    // Forme FlagshipRouter
    provider, data: { url: data.url, title: data.title, content, format, length: content.length },
    // Anciens champs (compatibilité)
    url: data.url, title: data.title, text: content, truncated: !!data.truncated, status: data.status ?? 200, contentType: data.contentType ?? '',
    metrics: { response_time_ms: Date.now() - t0 },
  };
}

export const hasProvider = (id) => !!getProvider(id);
