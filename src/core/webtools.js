// Copyright (c) 2026 Fido-labs —kcw—
// Outils web gratuits : recherche (SearXNG, DuckDuckGo Instant Answer, Wikipédia)
// et lecture de page (avec garde anti-SSRF : adresses privées refusées à la connexion).
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { lookup } from 'node:dns';
import { VERSION } from '../config.js';

/* ───────── Garde SSRF ───────── */

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)
      || a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    if (s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')) return true;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true;
}

function guardedLookup(hostname, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  const opts = typeof options === 'function' ? {} : options;
  lookup(hostname, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: 4 }];
    for (const a of list) {
      if (isPrivateIp(a.address)) return cb(new Error('adresse réseau non autorisée'));
    }
    if (opts.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

function requestOnce(url, { timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: 'GET',
      lookup: guardedLookup,
      timeout: timeoutMs,
      headers: {
        'user-agent': `Mozilla/5.0 (compatible; PhenixRouter/${VERSION})`,
        accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5',
        'accept-encoding': 'identity',
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(new Error('page trop volumineuse')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('délai dépassé')));
    req.on('error', reject);
    req.end();
  });
}

function assertPublicUrl(u) {
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('seuls http et https sont autorisés');
  if (u.username || u.password) throw new Error('identifiants dans l’URL interdits');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isPrivateIp(host)) throw new Error('adresse réseau non autorisée');
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error('hôte local non autorisé');
}

export async function fetchPublic(rawUrl, { maxBytes = 2 * 1024 * 1024, timeoutMs = 15000, maxRedirects = 3 } = {}) {
  let url = new URL(rawUrl);
  for (let i = 0; i <= maxRedirects; i += 1) {
    assertPublicUrl(url);
    const r = await requestOnce(url, { timeoutMs, maxBytes });
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) {
      url = new URL(r.headers.location, url);
      continue;
    }
    return { status: r.status, contentType: String(r.headers['content-type'] ?? ''), finalUrl: url.toString(), body: r.body };
  }
  throw new Error('trop de redirections');
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&apos;': "'" };

export function htmlToText(html) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
  const text = html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp|apos);/g, (m) => ENTITIES[m])
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const decodedTitle = title.replace(/&(amp|lt|gt|quot|#39|nbsp|apos);/g, (m) => ENTITIES[m]);
  return { title: decodedTitle.replace(/\s+/g, ' ').slice(0, 300), text };
}

export async function webFetch(url, { maxChars = 20000 } = {}) {
  const r = await fetchPublic(url);
  const ct = r.contentType.toLowerCase();
  if (!/(text\/|application\/(json|xml|xhtml)|\+json|\+xml)/.test(ct)) {
    throw new Error(`type de contenu non pris en charge : ${ct || 'inconnu'}`);
  }
  const raw = r.body.toString('utf8');
  const { title, text } = ct.includes('html') ? htmlToText(raw) : { title: '', text: raw };
  const limit = Math.min(Math.max(Number(maxChars) || 20000, 500), 100000);
  return {
    url: r.finalUrl, status: r.status, title, contentType: r.contentType,
    text: text.slice(0, limit), truncated: text.length > limit,
  };
}

/* ───────── Recherche ───────── */

const stripTags = (s) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/&(amp|lt|gt|quot|#39|nbsp|apos);/g, (m) => ENTITIES[m]);

async function getJson(url, timeoutMs = 8000) {
  const res = await fetch(url, { headers: { 'user-agent': `PhenixRouter/${VERSION}`, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function searchSearx(base, q, limit) {
  const json = await getJson(`${base}/search?q=${encodeURIComponent(q)}&format=json`, 12000);
  return (json.results ?? []).slice(0, limit).map((r) => ({
    title: r.title ?? '', url: r.url ?? '', snippet: r.content ?? '', source: 'searxng',
  }));
}

async function searchDuckInstant(q) {
  const json = await getJson(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`);
  const out = [];
  if (json.AbstractText) out.push({ title: json.Heading || q, url: json.AbstractURL || '', snippet: json.AbstractText, source: 'duckduckgo' });
  const walk = (topics) => {
    for (const t of topics ?? []) {
      if (t.Topics) walk(t.Topics);
      else if (t.Text) out.push({ title: t.Text.split(' - ')[0].slice(0, 120), url: t.FirstURL ?? '', snippet: t.Text, source: 'duckduckgo' });
    }
  };
  walk(json.RelatedTopics);
  return out;
}

async function searchWikipedia(q, lang, limit) {
  const json = await getJson(`https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=${limit}&origin=*`);
  return (json.query?.search ?? []).map((r) => ({
    title: r.title,
    url: `https://${lang}.wikipedia.org/?curid=${r.pageid}`,
    snippet: stripTags(r.snippet),
    source: `wikipedia-${lang}`,
  }));
}

export async function webSearch(settings, query, { limit = 8 } = {}) {
  const q = String(query ?? '').trim().slice(0, 300);
  if (!q) throw new Error('requête vide');
  const n = Math.min(Math.max(Number(limit) || 8, 1), 20);
  if (settings.searxngUrl) {
    return { query: q, backend: 'searxng', results: await searchSearx(settings.searxngUrl, q, n) };
  }
  const settled = await Promise.allSettled([searchDuckInstant(q), searchWikipedia(q, 'fr', 5), searchWikipedia(q, 'en', 5)]);
  const results = [];
  const seen = new Set();
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    for (const r of s.value) {
      if (!r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      results.push(r);
    }
  }
  return { query: q, backend: 'duckduckgo+wikipedia', results: results.slice(0, n) };
}
