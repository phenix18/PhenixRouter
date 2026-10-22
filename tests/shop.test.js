// Copyright (c) 2026 Fido-labs —kcw—
// Tests du module « Vente de tokens » (optionnel) : prix, commandes, licences, consommation, REA, Binance Pay, garde-fous.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMockUpstream, createRouter } from './helpers.js';
import { priceOrder, multiplierFor, chargeFor, normalizeShop, DEFAULT_SHOP } from '../src/shop/model.js';
import { binanceSignature, binancepay } from '../src/shop/payments.js';
import { ShopService } from '../src/shop/service.js';
import { realIp, viaProxy } from '../src/api/http.js';

let up; let r; let shop; let groqConn;
const pub = (path, opts = {}) => fetch(`${r.app.url}${path}`, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
const chat = (key, content = 'salut') => r.api('/v1/chat/completions', { method: 'POST', key, body: { model: 'groq/groq-model-a', messages: [{ role: 'user', content }] } });

before(async () => {
  up = await createMockUpstream();
  r = await createRouter();
  shop = r.gw.shop;
  groqConn = r.gw.addConnection({ provider: 'groq', name: 'groq-revente', apiKey: 'gsk_x', baseUrl: up.url('groq') });
  await r.gw.catalog.refresh({ force: true });
  shop.updateSettings({ enabled: true, publicUrl: 'https://shop.example.com' });
});
after(async () => { await r.close(); await up.close(); });

test('prix : 1 M = 3 USD, packs, montant libre borné, multiplicateurs, débit', () => {
  const s = normalizeShop({}, DEFAULT_SHOP);
  assert.deepEqual(priceOrder(s, { packId: 'p1' }), { tokens: 1_000_000, amountUsd: 3 });
  assert.equal(priceOrder(s, { millions: 2.5 }).amountUsd, 7.5);
  assert.throws(() => priceOrder(s, { millions: 0 }));
  assert.throws(() => priceOrder(s, { millions: 1e9 }));
  assert.throws(() => priceOrder(s, { packId: 'inconnu' }));
  assert.equal(multiplierFor({ 'groq/*': 2, 'groq/x': 5 }, 'groq/x'), 5);
  assert.equal(multiplierFor({ 'groq/*': 2 }, 'groq/y'), 2);
  assert.equal(multiplierFor({}, 'a/b'), 1);
  assert.equal(chargeFor(100, 50, 2), 300);
});

test('signature Binance Pay : HMAC-SHA512 majuscule déterministe', () => {
  const a = binanceSignature('s3cret', '1700000000000', 'nonce', '{"a":1}');
  assert.match(a, /^[0-9A-F]{128}$/);
  assert.equal(a, binanceSignature('s3cret', '1700000000000', 'nonce', '{"a":1}'));
  assert.notEqual(a, binanceSignature('autre', '1700000000000', 'nonce', '{"a":1}'));
});

test('secrets Binance : scellés sur disque, jamais renvoyés par l’administration', () => {
  shop.updateSettings({ methods: { binancepay: { enabled: false, apiKey: 'BP_KEY_123', secret: 'BP_SECRET_456' } } });
  const raw = JSON.stringify(r.gw.db.shop);
  assert.ok(!raw.includes('BP_KEY_123') && !raw.includes('BP_SECRET_456'));
  const adm = shop.adminSettings().methods.binancepay;
  assert.equal(adm.apiKey, ''); assert.equal(adm.secret, ''); assert.equal(adm.hasSecret, true);
  assert.equal(shop.settings().methods.binancepay.secret, 'BP_SECRET_456');
  shop.updateSettings({ methods: { binancepay: { label: 'Binance' } } });
  assert.equal(shop.settings().methods.binancepay.secret, 'BP_SECRET_456', 'mise à jour partielle : secret conservé');
});

test('boutique désactivée → 404 ; page et config publiques quand activée', async () => {
  shop.updateSettings({ enabled: false });
  assert.equal((await pub('/shop')).status, 404);
  assert.equal((await pub('/shop-api/config')).status, 404);
  shop.updateSettings({ enabled: true });
  const cfg = await (await pub('/shop-api/config')).json();
  assert.equal(cfg.pricePerMillionUsd, 3);
  assert.ok(!JSON.stringify(cfg).includes('BP_SECRET'));
  assert.deepEqual(cfg.methods.map((m) => m.id), ['manual']);
});

let order; let token; let license;
test('commande manuelle → confirmation admin → licence remise une seule fois (idempotent) + dualité REA', async () => {
  const res = await pub('/shop-api/orders', { method: 'POST', body: { packId: 'p5', contact: 'client@exemple.com', method: 'manual' } });
  assert.equal(res.status, 201);
  ({ order, token } = await res.json());
  assert.equal(order.tokens, 5_000_000); assert.equal(order.amountUsd, 15); assert.equal(order.status, 'pending');
  assert.ok(order.payment.instructions.includes(order.reference));
  // pas de clé avant paiement ; mauvais jeton refusé
  assert.equal((await pub(`/shop-api/orders/${order.id}?t=mauvais`)).status, 404);
  assert.equal((await (await pub(`/shop-api/orders/${order.id}?t=${token}`)).json()).order.licenseKey, undefined);
  shop.markPaid(order.id, { method: 'manual', txid: 'TX1' });
  shop.markPaid(order.id, { method: 'manual', txid: 'TX1' });
  const got = (await (await pub(`/shop-api/orders/${order.id}?t=${token}`)).json()).order;
  assert.equal(got.status, 'delivered');
  license = got.licenseKey;
  assert.match(license, /^phx-/);
  assert.equal(shop.listLicenses().length, 1);
  assert.equal(shop.listLicenses()[0].granted, 5_000_000);
  const st = shop.stats();
  assert.equal(st.revenueUsd, 15); assert.equal(st.tokensSold, 5_000_000);
  assert.equal(st.duality.ok, true); assert.equal(st.chain.ok, true);
});

test('licence vendue : /v1 fonctionne, routage limité aux connexions « resale », solde débité', async () => {
  const noResale = await chat(license);
  assert.notEqual(noResale.status, 200, 'sans connexion resale, aucun accès aux clés du propriétaire');
  r.gw.updateConnection(groqConn.id, { resale: true });
  const ok = await chat(license, 'bonjour');
  assert.equal(ok.status, 200);
  const acc = shop.account(license);
  assert.ok(acc.used > 0 && acc.balance === acc.granted - acc.used);
  // un client normal garde accès à la connexion
  assert.equal((await chat(r.apiKey)).status, 200);
});

test('compte public : solde et usage via /shop-api/account ; licence inconnue → 404', async () => {
  const res = await pub('/shop-api/account', { method: 'POST', body: { licenseKey: license } });
  assert.equal(res.status, 200);
  const { account } = await res.json();
  assert.ok(account.used > 0 && account.recent.length > 0);
  assert.ok(!JSON.stringify(account).includes(license));
  assert.equal((await pub('/shop-api/account', { method: 'POST', body: { licenseKey: 'phx-nope' } })).status, 404);
});

test('crédit épuisé → 402 insufficient_credits ; recharge par la même licence → 200', async () => {
  const rec = r.gw.db.apiKeys.find((k) => k.sold);
  rec.credits.used = rec.credits.granted;
  const out = await chat(license);
  assert.equal(out.status, 402);
  assert.equal((await out.json()).error.code, 'insufficient_credits');
  const o = await pub('/shop-api/orders', { method: 'POST', body: { packId: 'p1', contact: 'client@exemple.com', licenseKey: license } });
  const { order: o2 } = await o.json();
  shop.markPaid(o2.id, { method: 'manual' });
  assert.equal(shop.listLicenses().length, 1, 'recharge : pas de nouvelle clé');
  assert.equal((await chat(license, 'après recharge')).status, 200);
  assert.equal(shop.stats().duality.ok, true);
});

test('remise hors ligne (grant) : même circuit comptable, cadeau à 0 $ ; annulation seulement si en attente', async () => {
  const g = shop.grant({ tokens: 2_000_000, contact: 'mobile-money', amountUsd: 6 });
  assert.match(g.licenseKey, /^phx-/);
  assert.equal(shop.stats().revenueUsd, 15 + 3 + 6);
  const o = await pub('/shop-api/orders', { method: 'POST', body: { packId: 'p1', contact: 'zz@zz.zz' } });
  const { order: p } = await o.json();
  assert.equal(shop.cancelOrder(p.id).status, 'canceled');
  assert.throws(() => shop.markPaid(p.id, {}), /annulée/);
  assert.equal(shop.stats().duality.ok, true);
});

test('Binance Pay : création signée, statut vérifié par requête (pas de confiance au webhook), montant contrôlé', async () => {
  const calls = [];
  let status = 'PENDING'; let amount = 3;
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/v3/order')) return new Response(JSON.stringify({ status: 'SUCCESS', code: '000000', data: { prepayId: 'pp1', checkoutUrl: 'https://pay.binance.test/x', expireTime: Date.now() + 3600_000 } }), { status: 200 });
    return new Response(JSON.stringify({ status: 'SUCCESS', code: '000000', data: { status, orderAmount: amount, currency: 'USDT' } }), { status: 200 });
  };
  const s2 = new ShopService(r.gw, { fetchFn });
  s2.updateSettings({ enabled: true, methods: { binancepay: { enabled: true, apiKey: 'K', secret: 'S' } } });
  assert.ok(binancepay.configured(s2.settings().methods.binancepay));
  const { order: o, token: t } = await s2.createOrder({ packId: 'p1', contact: 'bin@x.io', method: 'binancepay', ip: '1.2.3.4' });
  assert.equal(o.payment.checkoutUrl, 'https://pay.binance.test/x');
  const sent = calls[0].init;
  assert.equal(sent.headers['BinancePay-Signature'], binanceSignature('S', sent.headers['BinancePay-Timestamp'], sent.headers['BinancePay-Nonce'], sent.body));
  // webhook falsifié : ne crédite pas tant que l'API ne confirme pas
  s2._lastPoll.clear();
  await s2.onBinanceWebhook({ data: JSON.stringify({ merchantTradeNo: `PHX${o.id.replace('_', '')}` }) });
  assert.equal((await s2.getOrder(o.id, t)).status, 'pending');
  // montant insuffisant
  status = 'PAID'; amount = 1; s2._lastPoll.clear();
  assert.equal((await s2.getOrder(o.id, t)).status, 'pending');
  // paiement conforme
  amount = 3; s2._lastPoll.clear();
  const done = await s2.getOrder(o.id, t);
  assert.equal(done.status, 'delivered');
  assert.match(done.licenseKey, /^phx-/);
  assert.equal(r.gw.shop.stats().duality.ok, true);
  s2.updateSettings({ methods: { binancepay: { enabled: false } } });
});

test('garde-fous : limites de débit par IP réelle, IP derrière tunnel, administration non exposée', async () => {
  assert.equal(realIp({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'cf-connecting-ip': '9.9.9.9' } }), '9.9.9.9');
  assert.equal(realIp({ socket: { remoteAddress: '8.8.8.8' }, headers: { 'cf-connecting-ip': '9.9.9.9' } }), '8.8.8.8', 'en-tête ignoré si connexion directe non locale');
  assert.equal(viaProxy({ headers: { 'x-forwarded-for': '1.1.1.1' } }), true);
  const hdr = { 'cf-connecting-ip': '5.5.5.5' };
  assert.equal((await pub('/api/overview', { headers: hdr })).status, 403, 'admin refusée via tunnel tant que la boutique est active');
  assert.equal((await pub('/api/session', { headers: hdr })).status, 403);
  let last = 0;
  for (let i = 0; i < 12; i += 1) last = (await pub('/shop-api/orders', { method: 'POST', headers: { 'cf-connecting-ip': '6.6.6.6' }, body: { packId: 'p1', contact: 'a@b.c' } })).status;
  assert.equal(last, 429);
  assert.equal((await pub('/shop-api/orders', { method: 'POST', headers: { 'cf-connecting-ip': '7.7.7.7' }, body: { packId: 'p1', contact: '' } })).status, 400);
});

test('fenêtre de remise : la clé en clair disparaît après 24 h', async () => {
  const o = shop.orders.find((x) => x.id === order.id);
  assert.ok(o.licenseSealed);
  o.revealUntil = Date.now() - 1;
  shop._sweep();
  assert.equal(o.licenseSealed, undefined);
  const got = (await (await pub(`/shop-api/orders/${order.id}?t=${token}`)).json()).order;
  assert.equal(got.licenseKey, undefined);
});
