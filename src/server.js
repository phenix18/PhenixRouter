// Copyright (c) 2026 Fido-labs —kcw—
// Serveur HTTP : /v1/* (passerelle), /api/* (administration), fichiers statiques du tableau de bord.
import http from 'node:http';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { posix } from 'node:path';
import { BRAND, VERSION } from './config.js';
import { readAsset } from './assets.js';
import { Gateway } from './gateway.js';
import { handleV1 } from './api/v1.js';
import { handleAdmin } from './api/admin.js';
import { handleGemini } from './api/gemini.js';
import { handleMcp } from './api/mcp.js';
import { handleShopPublic } from './shop/api.js';
import { sendJson, openaiErrorBody } from './api/http.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function securityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
}

function applyCors(gw, req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  const allowed = gw.settings().corsOrigins;
  let sameHost = false;
  try { sameHost = new URL(origin).host === req.headers.host; } catch { /* ignore */ }
  if (sameHost || allowed.includes('*') || allowed.includes(origin)) {
    res.setHeader('access-control-allow-origin', allowed.includes('*') && !sameHost ? '*' : origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'authorization,content-type,x-api-key,x-goog-api-key,anthropic-version,anthropic-beta');
    res.setHeader('access-control-max-age', '600');
  }
}

async function serveStatic(req, res, pathname) {
  let rel;
  try { rel = posix.normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname)); } catch { res.writeHead(400); res.end(); return; }
  if (rel.includes('..') || rel.includes('\0') || rel.includes('\\')) { res.writeHead(403); res.end(); return; }
  try {
    const data = readAsset(`public${rel}`);
    const type = MIME[posix.extname(rel)] ?? 'application/octet-stream';
    const headers = { 'content-type': type, 'cache-control': 'no-cache' };
    if (type.startsWith('text/html')) headers['content-security-policy'] = CSP;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    // SPA : toute route inconnue renvoie l'application
    try {
      res.writeHead(200, { 'content-type': MIME['.html'], 'content-security-policy': CSP, 'cache-control': 'no-cache' });
      res.end(readAsset('public/index.html'));
    } catch {
      res.writeHead(404); res.end('Not found');
    }
  }
}

export function createApp(gw) {
  return http.createServer(async (req, res) => {
    securityHeaders(res);
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    const ctx = { signal: ac.signal };
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      applyCors(gw, req, res);
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      if (url.pathname === '/healthz' || url.pathname === '/health' || url.pathname === '/api/health') {
        const conns = gw.connections().filter((c) => c.enabled);
        sendJson(res, 200, {
          ok: true, status: 'ok', name: BRAND.name, version: VERSION, uptimeSec: Math.round((Date.now() - gw.startedAt) / 1000),
          connections: conns.length, modelsReady: gw.catalog.list().filter((m) => m.status === 'ready').length, costMode: gw.settings().costMode,
        });
        return;
      }
      if (url.pathname === '/mcp') { await handleMcp(gw, req, res, ctx); return; }
      if (url.pathname.startsWith('/v1beta')) { await handleGemini(gw, req, res, url, ctx); return; }
      if (url.pathname.startsWith('/v1')) { await handleV1(gw, req, res, url, ctx); return; }
      if (url.pathname.startsWith('/shop-api/') && await handleShopPublic(gw, req, res, url)) return;
      if (url.pathname === '/shop' || url.pathname.startsWith('/shop/')) {
        if (!gw.shop.settings().enabled) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Boutique désactivée'); return; }
        await serveStatic(req, res, url.pathname === '/shop' || url.pathname === '/shop/' ? '/shop/index.html' : url.pathname);
        return;
      }
      if (url.pathname.startsWith('/api/')) { await handleAdmin(gw, req, res, url); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, openaiErrorBody(405, 'Méthode non autorisée', 'invalid_request_error'));
        return;
      }
      await serveStatic(req, res, url.pathname);
    } catch (e) {
      gw.log({ level: 'error', message: `serveur: ${e?.stack ?? e}` });
      if (!res.headersSent) sendJson(res, 500, openaiErrorBody(500, 'Erreur interne'));
      else res.end();
    }
  });
}

/**
 * Démarre le serveur. Renvoie { server, gw, port, url, close }.
 * @param {{port?:number, host?:string, dataDir?:string}} opts
 */
export async function start({ port, host = '127.0.0.1', dataDir, portFallback = 0 } = {}) {
  const gw = new Gateway({ dataDir });
  const creds = gw.ensureCredentials();
  const server = createApp(gw);
  server.requestTimeout = 0; // les flux SSE peuvent durer
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 65_000;

  // Port occupé : on essaie les `portFallback` ports suivants (20128 → 20129 → 20130…) au lieu d'échouer.
  const firstPort = port ?? BRAND.defaultPort;
  const tryListen = (p) => new Promise((resolve, reject) => {
    const onError = (e) => { server.off('listening', onOk); reject(e); };
    const onOk = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onOk);
    server.listen(p, host);
  });
  let attempt = 0;
  for (;;) {
    try { await tryListen(firstPort === 0 ? 0 : firstPort + attempt); break; } catch (e) {
      if (e?.code === 'EADDRINUSE' && attempt < portFallback) { attempt += 1; continue; }
      throw e;
    }
  }
  const actualPort = server.address().port;
  try { writeFileSync(join(gw.dir, 'port'), String(actualPort)); } catch { /* ignore */ }
  const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;

  // Rafraîchit le catalogue en arrière-plan, puis périodiquement.
  gw.catalog.refresh().catch(() => {});
  const timer = setInterval(() => { if (gw.catalog.isStale()) gw.catalog.refresh().catch(() => {}); }, 5 * 60_000);
  timer.unref?.();
  gw.monitor.start();
  setTimeout(() => { gw.monitor.sweep().catch(() => {}); }, 20_000).unref?.();

  return {
    server, gw, creds, port: actualPort, url: `http://${shown}:${actualPort}`,
    close: () => new Promise((resolve) => {
      clearInterval(timer);
      try { rmSync(join(gw.dir, 'port'), { force: true }); } catch { /* ignore */ }
      gw.close();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
