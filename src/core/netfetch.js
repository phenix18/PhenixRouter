// Copyright (c) 2026 Fido-labs —kcw—
// fetch() à travers un proxy HTTP/HTTPS sortant (tunnel CONNECT), sans aucune dépendance.
// Sert aux « pools de proxys » : une connexion fournisseur peut sortir par un proxy dédié
// (ou par un pool en rotation). SOCKS n'est volontairement pas géré (pas de dépendance).
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { Readable } from 'node:stream';

const NO_BODY = new Set([101, 204, 205, 304]);

/** Valide une URL de proxy et renvoie l'objet URL ; lève une erreur lisible sinon. */
export function parseProxyUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new Error('URL de proxy invalide'); }
  if (u.protocol === 'socks:' || u.protocol === 'socks5:' || u.protocol === 'socks4:' || u.protocol === 'socks5h:') {
    throw new Error('SOCKS non supporté : utilisez un proxy HTTP/HTTPS (ou un pont SOCKS→HTTP local)');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Le proxy doit commencer par http:// ou https://');
  if (!u.hostname) throw new Error('Hôte du proxy manquant');
  return u;
}

/** Masque les identifiants d'une URL de proxy pour l'affichage. */
export function maskProxyUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.username || u.password) { u.username = '***'; u.password = ''; }
    return u.toString().replace(/\/$/, '');
  } catch { return ''; }
}

const authHeader = (u) => (u.username
  ? `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`
  : null);

function openProxySocket(proxy, timeoutMs) {
  return new Promise((resolve, reject) => {
    const port = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
    const sock = proxy.protocol === 'https:'
      ? tls.connect({ host: proxy.hostname, port, servername: proxy.hostname })
      : net.connect({ host: proxy.hostname, port });
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('délai de connexion au proxy dépassé')); }, timeoutMs);
    sock.once(proxy.protocol === 'https:' ? 'secureConnect' : 'connect', () => { clearTimeout(timer); resolve(sock); });
    sock.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/** Établit un tunnel CONNECT vers host:port et renvoie le socket brut. */
async function connectTunnel(proxy, host, port, timeoutMs = 15000) {
  const sock = await openProxySocket(proxy, timeoutMs);
  const auth = authHeader(proxy);
  sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}Proxy-Connection: keep-alive\r\n\r\n`);
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('délai CONNECT dépassé')); }, timeoutMs);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) { if (buf.length > 16384) { clearTimeout(timer); sock.destroy(); reject(new Error('réponse du proxy invalide')); } return; }
      clearTimeout(timer);
      sock.off('data', onData);
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(buf.subarray(0, end).toString('latin1'))?.[1]);
      if (status !== 200) { sock.destroy(); reject(new Error(status === 407 ? 'proxy : authentification refusée (407)' : `proxy : CONNECT refusé (${status || '?'})`)); return; }
      const rest = buf.subarray(end + 4);
      if (rest.length) sock.unshift(rest);
      resolve(sock);
    };
    sock.on('data', onData);
    sock.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function toResponse(res) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x)); else if (v != null) headers.set(k, String(v));
  }
  const body = NO_BODY.has(res.statusCode) ? null : Readable.toWeb(res);
  return new Response(body, { status: res.statusCode, statusText: res.statusMessage, headers });
}

/**
 * Équivalent de fetch(url, init) en sortant par `proxyUrl`.
 * Options internes : init.tlsOptions (ex. { ca }) pour les tests.
 */
export async function fetchViaProxy(proxyUrl, url, init = {}) {
  const proxy = parseProxyUrl(proxyUrl);
  const target = new URL(url);
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = {};
  new Headers(init.headers ?? {}).forEach((v, k) => { headers[k] = v; });
  headers['accept-encoding'] ??= 'identity';
  headers.connection = 'close';
  let body = init.body;
  if (body != null && typeof body !== 'string' && !Buffer.isBuffer(body)) body = Buffer.from(await new Response(body).arrayBuffer());
  if (body != null) headers['content-length'] = String(Buffer.byteLength(body));
  if (init.signal?.aborted) throw init.signal.reason ?? new Error('annulé');

  const isHttps = target.protocol === 'https:';
  const port = Number(target.port) || (isHttps ? 443 : 80);
  let agentOpts;
  if (isHttps) {
    const raw = await connectTunnel(proxy, target.hostname, port);
    const secure = tls.connect({ socket: raw, servername: target.hostname, ...(init.tlsOptions ?? {}) });
    await new Promise((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', reject); });
    agentOpts = { createConnection: () => secure, agent: undefined };
  } else {
    // Cible http:// : requête « forward proxy » classique.
    const auth = authHeader(proxy);
    if (auth) headers['proxy-authorization'] = auth;
  }

  return new Promise((resolve, reject) => {
    const lib = isHttps ? https : http;
    const opts = isHttps
      ? { host: target.hostname, port, path: `${target.pathname}${target.search}`, method, headers, ...agentOpts }
      : { host: proxy.hostname, port: Number(proxy.port) || 80, path: target.toString(), method, headers: { ...headers, host: target.host }, agent: false };
    const req = lib.request(opts, (res) => resolve(toResponse(res)));
    const onAbort = () => req.destroy(init.signal.reason ?? new Error('annulé'));
    init.signal?.addEventListener('abort', onAbort, { once: true });
    req.once('close', () => init.signal?.removeEventListener('abort', onAbort));
    req.once('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}
