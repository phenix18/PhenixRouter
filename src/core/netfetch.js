// Copyright (c) 2026 Fido-labs —kcw—
// fetch() à travers un proxy HTTP/HTTPS sortant (tunnel CONNECT), sans aucune dépendance.
// Sert aux « pools de proxys » : une connexion fournisseur peut sortir par un proxy dédié
// (ou par un pool en rotation). HTTP, HTTPS et SOCKS5 (socks5h : résolution DNS côté proxy, sans fuite DNS).
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
  if (u.protocol === 'socks4:' || u.protocol === 'socks:') throw new Error('SOCKS4 non supporté : utilisez socks5:// (ou socks5h://)');
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(u.protocol)) throw new Error('Le proxy doit commencer par http://, https://, socks5:// ou socks5h://');
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
    const port = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : isSocks(proxy) ? 1080 : 80);
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

const isSocks = (proxy) => proxy.protocol === 'socks5:' || proxy.protocol === 'socks5h:';

/** Lecteur d'octets exacts sur un socket (poignée de main SOCKS5). */
function reader(sock) {
  let buf = Buffer.alloc(0); let waiting = null; let failure = null;
  const wake = () => { if (waiting && (buf.length >= waiting.n || failure)) { const w = waiting; waiting = null; failure ? w.reject(failure) : w.resolve(); } };
  sock.on('data', (c) => { buf = Buffer.concat([buf, c]); wake(); });
  sock.once('error', (e) => { failure = e; wake(); });
  sock.once('close', () => { failure ??= new Error('connexion fermée par le proxy SOCKS'); wake(); });
  return {
    async take(n) {
      if (buf.length < n) await new Promise((resolve, reject) => { waiting = { n, resolve, reject }; wake(); });
      const out = buf.subarray(0, n); buf = buf.subarray(n); return out;
    },
    rest() { const r = buf; buf = Buffer.alloc(0); return r; },
    stop() { sock.removeAllListeners('data'); },
  };
}

const SOCKS_ERRORS = { 1: 'échec général', 2: 'connexion interdite par le proxy', 3: 'réseau inaccessible', 4: 'hôte inaccessible', 5: 'connexion refusée', 6: 'TTL expiré', 7: 'commande non supportée', 8: 'adresse non supportée' };

/** Tunnel SOCKS5 (RFC 1928, auth utilisateur/mot de passe RFC 1929) vers host:port ; renvoie le socket brut. */
export async function socksConnect(proxy, host, port, timeoutMs = 15000) {
  const sock = await openProxySocket(proxy, timeoutMs);
  const rd = reader(sock);
  const timer = setTimeout(() => sock.destroy(new Error('délai SOCKS5 dépassé')), timeoutMs);
  try {
    const user = proxy.username ? decodeURIComponent(proxy.username) : null;
    const pass = decodeURIComponent(proxy.password || '');
    sock.write(Buffer.from(user != null ? [5, 2, 0, 2] : [5, 1, 0]));
    const [ver, method] = await rd.take(2);
    if (ver !== 5) throw new Error('réponse SOCKS5 invalide');
    if (method === 0xff) throw new Error('proxy SOCKS5 : aucune méthode d’authentification acceptable');
    if (method === 2) {
      if (user == null) throw new Error('proxy SOCKS5 : identifiants requis');
      const u = Buffer.from(user); const p = Buffer.from(pass);
      if (u.length > 255 || p.length > 255) throw new Error('identifiants SOCKS5 trop longs');
      sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
      const [, st] = await rd.take(2);
      if (st !== 0) throw new Error('proxy SOCKS5 : authentification refusée');
    } else if (method !== 0) throw new Error('méthode SOCKS5 non supportée');
    const h = Buffer.from(host);
    if (h.length > 255) throw new Error('nom d’hôte trop long');
    sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 255])]));
    const [v2, rep, , atyp] = await rd.take(4);
    if (v2 !== 5) throw new Error('réponse SOCKS5 invalide');
    if (rep !== 0) throw new Error(`proxy SOCKS5 : ${SOCKS_ERRORS[rep] ?? `erreur ${rep}`}`);
    await rd.take(atyp === 1 ? 6 : atyp === 4 ? 18 : (await rd.take(1))[0] + 2);
    const rest = rd.rest(); rd.stop();
    if (rest.length) sock.unshift(rest);
    return sock;
  } catch (e) {
    sock.destroy();
    throw e;
  } finally {
    clearTimeout(timer);
  }
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
  let tunnel = null; // socket du tunnel : fermé avec la requête (pas de fuite de descripteurs)
  if (isSocks(proxy)) {
    const raw = await socksConnect(proxy, target.hostname, port);
    if (isHttps) {
      const secure = tls.connect({ socket: raw, servername: target.hostname, ...(init.tlsOptions ?? {}) });
      await new Promise((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', reject); });
      tunnel = secure; agentOpts = { createConnection: () => secure, agent: undefined };
    } else { tunnel = raw; agentOpts = { createConnection: () => raw, agent: undefined }; }
  } else if (isHttps) {
    const raw = await connectTunnel(proxy, target.hostname, port);
    const secure = tls.connect({ socket: raw, servername: target.hostname, ...(init.tlsOptions ?? {}) });
    await new Promise((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', reject); });
    tunnel = secure; agentOpts = { createConnection: () => secure, agent: undefined };
  } else {
    // Cible http:// : requête « forward proxy » classique.
    const auth = authHeader(proxy);
    if (auth) headers['proxy-authorization'] = auth;
  }

  return new Promise((resolve, reject) => {
    const lib = isHttps ? https : http;
    const opts = isHttps || isSocks(proxy)
      ? { host: target.hostname, port, path: `${target.pathname}${target.search}`, method, headers, ...agentOpts }
      : { host: proxy.hostname, port: Number(proxy.port) || 80, path: target.toString(), method, headers: { ...headers, host: target.host }, agent: false };
    const req = lib.request(opts, (res) => resolve(toResponse(res)));
    const onAbort = () => req.destroy(init.signal.reason ?? new Error('annulé'));
    init.signal?.addEventListener('abort', onAbort, { once: true });
    req.once('close', () => { init.signal?.removeEventListener('abort', onAbort); tunnel?.destroy(); });
    req.once('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}
