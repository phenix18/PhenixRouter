// Copyright (c) 2026 Fido-labs —kcw—
// Routes de la boutique : publiques (/shop-api/*) et d'administration (/api/shop*).
import { httpError } from '../gateway.js';
import { readJson, sendJson, realIp, openaiErrorBody } from '../api/http.js';
import { ShopError } from './service.js';

const wrap = (e) => (e instanceof ShopError ? httpError(e.status, e.message, { type: e.type }) : e);

function limit(gw, req, bucket, max, windowMs = 60_000) {
  const r = gw.limiter.hit(`shop:${bucket}:${realIp(req)}`, max, windowMs);
  if (!r.ok) throw httpError(429, `Trop de requêtes, réessayez dans ${r.retryAfterSec}s`, { type: 'rate_limit_exceeded' });
}

/** Routes publiques. Renvoie true si la requête a été traitée. */
export async function handleShopPublic(gw, req, res, url) {
  const shop = gw.shop;
  const path = url.pathname.replace(/\/+$/, '');
  try {
    if (path === '/shop-api/config' && req.method === 'GET') {
      limit(gw, req, 'cfg', 120);
      const cfg = shop.publicConfig();
      if (!cfg.enabled) throw httpError(404, 'Boutique désactivée', { type: 'not_found' });
      sendJson(res, 200, cfg);
      return true;
    }
    if (path === '/shop-api/orders' && req.method === 'POST') {
      limit(gw, req, 'order', 10);
      const b = await readJson(req, 8192);
      sendJson(res, 201, await shop.createOrder({ ...b, ip: realIp(req) }));
      return true;
    }
    const m = /^\/shop-api\/orders\/(ord_[0-9a-f]{10})$/.exec(path);
    if (m && req.method === 'GET') {
      limit(gw, req, 'poll', 90);
      sendJson(res, 200, { order: await shop.getOrder(m[1], url.searchParams.get('t') ?? '') });
      return true;
    }
    if (path === '/shop-api/account' && req.method === 'POST') {
      limit(gw, req, 'acct', 20);
      const b = await readJson(req, 4096);
      if (!shop.settings().enabled) throw httpError(404, 'Boutique désactivée', { type: 'not_found' });
      sendJson(res, 200, { account: shop.account(String(b.licenseKey ?? '')) });
      return true;
    }
    if (path === '/shop-api/webhook/binancepay' && req.method === 'POST') {
      limit(gw, req, 'hook', 60);
      const body = await readJson(req, 65536);
      shop.onBinanceWebhook(body).catch(() => {});
      sendJson(res, 200, { returnCode: 'SUCCESS', returnMessage: null });
      return true;
    }
    return false;
  } catch (e) {
    const err = wrap(e);
    if (res.headersSent) { res.end(); return true; }
    sendJson(res, err.status ?? 500, openaiErrorBody(err.status ?? 500, err.message, err.type ?? 'api_error'));
    return true;
  }
}

/** Routes d'administration (session déjà vérifiée par handleAdmin). Renvoie true si traitée. */
export async function handleShopAdmin(gw, req, res, route, path) {
  const shop = gw.shop;
  try {
    if (route === 'GET /api/shop') {
      sendJson(res, 200, { settings: shop.adminSettings(), stats: shop.stats(), orders: shop.listOrders(), licenses: shop.listLicenses(), publicPath: '/shop' });
      return true;
    }
    if (route === 'PUT /api/shop') {
      sendJson(res, 200, { settings: shop.updateSettings(await readJson(req, 65536)) });
      return true;
    }
    if (route === 'POST /api/shop/grant') {
      sendJson(res, 201, { order: shop.grant(await readJson(req, 4096)) });
      return true;
    }
    const m = /^\/api\/shop\/orders\/(ord_[0-9a-f]{10})\/(confirm|cancel)$/.exec(path);
    if (m && req.method === 'POST') {
      if (m[2] === 'confirm') {
        const b = await readJson(req, 2048);
        sendJson(res, 200, { order: shop.markPaid(m[1], { method: 'manual', txid: b.txid, note: b.note, amountUsd: b.amountUsd }, 'admin') });
      } else sendJson(res, 200, { order: shop.cancelOrder(m[1]) });
      return true;
    }
    const l = /^\/api\/shop\/licenses\/([0-9a-f-]{36})\/(toggle)$/.exec(path);
    if (l && req.method === 'POST') {
      const rec = gw.db.apiKeys.find((k) => k.id === l[1] && k.sold);
      if (!rec) throw httpError(404, 'Licence introuvable');
      rec.enabled = rec.enabled === false;
      gw.store.save();
      sendJson(res, 200, { licenses: shop.listLicenses() });
      return true;
    }
    return false;
  } catch (e) { throw wrap(e); }
}
