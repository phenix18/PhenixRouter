// Copyright (c) 2026 Fido-labs —kcw—
// Service « Vente de tokens » : commandes, paiements, licences prépayées, consommation, statistiques.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { randomToken, sha256 } from '../store.js';
import { DEFAULT_SHOP, ORDER_STATUS as S, normalizeShop, multiplierFor, chargeFor, priceOrder } from './model.js';
import { ShopLedger } from './ledger.js';
import { binancepay, tradeNo } from './payments.js';

const DAY = 86_400_000;
const REVEAL_WINDOW_MS = 24 * 3600_000;
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const clone = (v) => JSON.parse(JSON.stringify(v));
const safeEqual = (a, b) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const reference = () => `PHX-${[...randomBytes(6)].map((b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('')}`;
const ipHash = (ip) => createHash('sha256').update(`phx-ip:${ip}`).digest('hex').slice(0, 16);

export class ShopError extends Error {
  constructor(status, message, type = 'shop_error') { super(message); this.status = status; this.type = type; }
}

export class ShopService {
  constructor(gw, { fetchFn = fetch } = {}) {
    this.gw = gw;
    this.fetch = fetchFn;
    this.ledger = new ShopLedger(gw.dir);
    this._lastPoll = new Map();
  }

  get orders() { return (this.gw.db.orders ??= []); }

  /* ───────── Réglages ───────── */

  /** Réglages en clair (secrets Binance déchiffrés) — usage interne uniquement. */
  settings() {
    const raw = this.gw.db.shop ?? {};
    const merged = normalizeShop(raw, clone(DEFAULT_SHOP));
    const bp = merged.methods.binancepay;
    try { bp.apiKey = bp.apiKey ? this.gw.vault.open(bp.apiKey) : ''; bp.secret = bp.secret ? this.gw.vault.open(bp.secret) : ''; } catch { bp.apiKey = ''; bp.secret = ''; }
    return merged;
  }

  /** Réglages pour l'administrateur : les secrets ne quittent jamais le serveur. */
  adminSettings() {
    const s = this.settings();
    const bp = s.methods.binancepay;
    s.methods.binancepay = { ...bp, apiKey: '', secret: '', hasApiKey: !!bp.apiKey, hasSecret: !!bp.secret };
    return s;
  }

  updateSettings(patch) {
    const next = normalizeShop(patch, this.settings());
    const bp = next.methods.binancepay;
    bp.apiKey = bp.apiKey ? this.gw.vault.seal(bp.apiKey) : '';
    bp.secret = bp.secret ? this.gw.vault.seal(bp.secret) : '';
    this.gw.db.shop = next;
    this.gw.store.save();
    return this.adminSettings();
  }

  publicConfig() {
    const s = this.settings();
    return {
      enabled: s.enabled, brandName: s.brandName, currency: s.currency, pricePerMillionUsd: s.pricePerMillionUsd, packs: s.packs,
      allowCustomAmount: s.allowCustomAmount, minMillions: s.minMillions, maxMillions: s.maxMillions, multipliers: s.multipliers,
      contact: s.contact, notice: s.notice, publicUrl: s.publicUrl, orderTtlMin: s.orderTtlMin, validityDays: s.licenseValidityDays,
      methods: [
        ...(s.methods.manual.enabled ? [{ id: 'manual', label: s.methods.manual.label }] : []),
        ...(binancepay.configured({ ...s.methods.binancepay }) ? [{ id: 'binancepay', label: s.methods.binancepay.label }] : []),
      ],
    };
  }

  /* ───────── Licences (clés prépayées) ───────── */

  _soldKeyByToken(token) {
    if (!token || typeof token !== 'string') return null;
    const h = sha256(token.trim());
    return this.gw.db.apiKeys.find((k) => k.sold && k.hash === h) ?? null;
  }

  _newLicense(order, s) {
    const { record, key } = this.gw.createApiKey(`client-${order.reference}`, { rateLimitPerMin: s.soldKeyRateLimitPerMin });
    const rec = this.gw.db.apiKeys.find((k) => k.id === record.id);
    Object.assign(rec, { sold: true, resaleOnly: true, credits: { granted: 0, used: 0 }, contact: order.contact, createdByOrder: order.id });
    return { rec, key };
  }

  balance(rec) { return Math.max(0, (rec.credits?.granted ?? 0) - (rec.credits?.used ?? 0)); }

  /* ───────── Commandes ───────── */

  async createOrder({ packId, millions, contact, method = 'manual', licenseKey, ip = '' }) {
    const s = this.settings();
    if (!s.enabled) throw new ShopError(404, 'Boutique désactivée', 'not_found');
    const methods = this.publicConfig().methods.map((m) => m.id);
    if (!methods.includes(method)) throw new ShopError(400, 'Moyen de paiement indisponible', 'invalid_request_error');
    const buyer = String(contact ?? '').trim();
    if (buyer.length < 3 || buyer.length > 120) throw new ShopError(400, 'Indiquez un contact (e-mail, WhatsApp ou Telegram)', 'invalid_request_error');
    let price;
    try { price = priceOrder(s, { packId, millions }); } catch (e) { throw new ShopError(400, e.message, 'invalid_request_error'); }
    let topup = null;
    if (licenseKey) {
      topup = this._soldKeyByToken(licenseKey);
      if (!topup) throw new ShopError(404, 'Licence introuvable : vérifiez la clé à recharger', 'not_found');
    }
    this._sweep();
    const hash = ipHash(ip);
    const pendingMine = this.orders.filter((o) => o.status === S.PENDING && o.ipHash === hash).length;
    if (pendingMine >= 5) throw new ShopError(429, 'Trop de commandes en attente : payez ou attendez leur expiration', 'rate_limit_exceeded');
    if (this.orders.filter((o) => o.status === S.PENDING).length >= 1000) throw new ShopError(503, 'Boutique saturée, réessayez plus tard', 'unavailable');

    const token = randomToken(18);
    const now = Date.now();
    const order = {
      id: `ord_${randomBytes(5).toString('hex')}`, tokenHash: sha256(token), reference: reference(), status: S.PENDING, contact: buyer,
      method, tokens: price.tokens, amountUsd: price.amountUsd, currency: s.currency, createdAt: now, expiresAt: now + s.orderTtlMin * 60_000,
      topupKeyId: topup?.id ?? null, ipHash: hash, payment: {},
    };
    if (method === 'binancepay') {
      try {
        const base = s.publicUrl || '';
        const created = await binancepay.createOrder(s.methods.binancepay, order, {
          description: `${(price.tokens / 1e6).toFixed(price.tokens % 1e6 ? 2 : 0)}M tokens API`,
          webhookUrl: base ? `${base}/shop-api/webhook/binancepay` : undefined,
          returnUrl: base ? `${base}/shop?order=${order.id}` : undefined,
        }, this.fetch);
        order.payment = { prepayId: created.prepayId, checkoutUrl: created.checkoutUrl, deeplink: created.deeplink, qrcodeLink: created.qrcodeLink };
        if (created.expireTime) order.expiresAt = Math.max(order.expiresAt, Number(created.expireTime) || 0);
      } catch (e) {
        throw new ShopError(502, `Paiement Binance Pay indisponible : ${String(e.message).slice(0, 160)}`, 'upstream_unavailable');
      }
    }
    this.orders.push(order);
    this.gw.store.save();
    this.ledger.event('ORDER_COMMITTED', { orderId: order.id, reference: order.reference, tokens: order.tokens, amountUsd: order.amountUsd, currency: order.currency, method, topup: !!topup });
    this.gw.alert(`nouvelle commande ${order.reference} : ${(order.tokens / 1e6).toFixed(2)}M tokens — ${order.amountUsd} ${order.currency} (${method}) — ${buyer}`);
    return { order: this.view(order), token };
  }

  _find(id) { return this.orders.find((o) => o.id === id) ?? null; }

  _authorized(order, token) { return !!order && typeof token === 'string' && safeEqual(sha256(token), order.tokenHash); }

  /** Vue publique d'une commande (jamais de secrets ; la clé n'apparaît que pendant la fenêtre de remise). */
  view(order) {
    const s = this.settings();
    const base = s.methods.manual.instructions;
    const manual = (base.includes('{reference}') ? base : `${base}\n\nRéférence à indiquer : ${order.reference}`)
      .replaceAll('{reference}', order.reference).replaceAll('{amount}', String(order.amountUsd)).replaceAll('{currency}', order.currency);
    const out = {
      id: order.id, reference: order.reference, status: order.status, tokens: order.tokens, amountUsd: order.amountUsd, currency: order.currency,
      method: order.method, createdAt: order.createdAt, expiresAt: order.expiresAt, paidAt: order.paidAt ?? null, topup: !!order.topupKeyId,
      payment: order.method === 'manual'
        ? { instructions: manual, reference: order.reference }
        : { checkoutUrl: order.payment?.checkoutUrl ?? null, deeplink: order.payment?.deeplink ?? null, qrcodeLink: order.payment?.qrcodeLink ?? null },
    };
    if (order.status === S.DELIVERED && order.licenseSealed && Date.now() < (order.revealUntil ?? 0)) {
      try { out.licenseKey = this.gw.vault.open(order.licenseSealed); } catch { /* ignore */ }
    }
    return out;
  }

  /** Statut d'une commande pour l'acheteur (jeton secret requis). Interroge Binance Pay si besoin (au plus toutes les 4 s). */
  async getOrder(id, token) {
    const order = this._find(id);
    if (!this._authorized(order, token)) throw new ShopError(404, 'Commande introuvable', 'not_found');
    await this.refresh(order);
    if (order.status === S.DELIVERED && order.licenseSealed && !order.revealUntil) order.revealUntil = Date.now() + REVEAL_WINDOW_MS;
    this.gw.store.save();
    return this.view(order);
  }

  /** Revérifie le paiement Binance Pay (faisant foi) ; expire les commandes échues. */
  async refresh(order) {
    if (order.status === S.PENDING && order.method === 'binancepay') {
      const last = this._lastPoll.get(order.id) ?? 0;
      if (Date.now() - last > 4000) {
        this._lastPoll.set(order.id, Date.now());
        try {
          const cfg = this.settings().methods.binancepay;
          const q = await binancepay.queryOrder(cfg, order, this.fetch);
          if (q.status === 'PAID') {
            if (q.amount != null && q.amount + 1e-9 < order.amountUsd) {
              this.gw.alert(`commande ${order.reference} : montant Binance Pay (${q.amount}) inférieur au montant attendu (${order.amountUsd}) — non crédité`);
            } else {
              this.markPaid(order.id, { method: 'binancepay', txid: order.payment?.prepayId ?? null, note: 'vérifié via l’API Binance Pay' }, 'binancepay');
            }
          } else if (['EXPIRED', 'CANCELED', 'CANCELLED', 'ERROR'].includes(q.status)) {
            order.status = S.EXPIRED;
          }
        } catch (e) {
          this.gw.log({ level: 'error', message: `shop: Binance Pay injoignable (${String(e.message).slice(0, 120)})` });
        }
      }
    }
    if (order.status === S.PENDING && Date.now() > order.expiresAt) order.status = S.EXPIRED;
    return order;
  }

  _sweep() {
    const now = Date.now();
    for (const o of this.orders) {
      if (o.status === S.PENDING && now > o.expiresAt && o.method !== 'binancepay') o.status = S.EXPIRED;
      if (o.licenseSealed && o.revealUntil && now > o.revealUntil) { delete o.licenseSealed; }
    }
  }

  /** Webhook Binance Pay : sert uniquement à déclencher la revérification signée (jamais de crédit sur la foi du corps reçu). */
  async onBinanceWebhook(body) {
    let tradeNo_ = null;
    try { const data = typeof body?.data === 'string' ? JSON.parse(body.data) : body?.data; tradeNo_ = data?.merchantTradeNo ?? null; } catch { /* ignore */ }
    if (!tradeNo_) return false;
    const order = this.orders.find((o) => o.method === 'binancepay' && o.status === S.PENDING && tradeNo(o) === tradeNo_);
    if (!order) return false;
    this._lastPoll.delete(order.id);
    await this.refresh(order);
    return order.status === S.DELIVERED;
  }

  /* ───────── Encaissement et remise du crédit (dualité REA) ───────── */

  /** Enregistre l'encaissement puis remet le crédit. Idempotent : un paiement ne crédite qu'une seule fois. */
  markPaid(orderId, { method, txid = null, note = '', amountUsd } = {}, actor = 'admin') {
    const order = this._find(orderId);
    if (!order) throw new ShopError(404, 'Commande introuvable', 'not_found');
    if (order.status === S.DELIVERED || order.status === S.PAID) return this.view(order);
    if (order.status === S.CANCELED) throw new ShopError(409, 'Commande annulée', 'conflict');
    const s = this.settings();
    const paid = amountUsd != null ? Number(amountUsd) : order.amountUsd;
    if (!Number.isFinite(paid) || paid < 0) throw new ShopError(400, 'Montant invalide', 'invalid_request_error');
    order.status = S.PAID;
    order.paidAt = Date.now();
    order.payment = { ...order.payment, method: method ?? order.method, txid: txid ? String(txid).slice(0, 120) : null, note: String(note ?? '').slice(0, 200), paidUsd: paid };
    this.ledger.event('PAYMENT_RECEIVED', { orderId, amountUsd: paid, currency: order.currency, method: order.payment.method, txid: order.payment.txid, tokens: order.tokens }, actor);
    let rec; let key = null;
    if (order.topupKeyId) {
      rec = this.gw.db.apiKeys.find((k) => k.id === order.topupKeyId);
      if (!rec) throw new ShopError(409, 'Licence à recharger introuvable', 'conflict');
    } else {
      ({ rec, key } = this._newLicense(order, s));
      order.licenseSealed = this.gw.vault.seal(key);
      order.revealUntil = Date.now() + REVEAL_WINDOW_MS;
    }
    rec.credits.granted += order.tokens;
    if (s.licenseValidityDays > 0) rec.expiresAt = Math.max(rec.expiresAt ?? 0, Date.now() + s.licenseValidityDays * DAY);
    order.licenseKeyId = rec.id;
    order.status = S.DELIVERED;
    order.deliveredAt = Date.now();
    this.ledger.event('CREDIT_GRANTED', { orderId, tokens: order.tokens, keyId: rec.id, balance: this.balance(rec) }, actor);
    this.gw.store.save();
    this.gw.alert(`vente encaissée ${order.reference} : ${paid} ${order.currency} → ${(order.tokens / 1e6).toFixed(2)}M tokens remis (${order.payment.method})`);
    return this.view(order);
  }

  cancelOrder(orderId) {
    const order = this._find(orderId);
    if (!order) throw new ShopError(404, 'Commande introuvable', 'not_found');
    if (order.status !== S.PENDING) throw new ShopError(409, 'Seules les commandes en attente peuvent être annulées', 'conflict');
    order.status = S.CANCELED;
    this.gw.store.save();
    return this.view(order);
  }

  /** Remise manuelle (vente hors ligne : Mobile Money, espèces, cadeau) — passe par le même circuit comptable. */
  grant({ tokens, contact = 'hors-ligne', amountUsd = 0, method = 'offline', note = '', keyId = null }) {
    const t = Math.round(Number(tokens));
    if (!Number.isFinite(t) || t < 1000 || t > 1e12) throw new ShopError(400, 'Nombre de tokens invalide', 'invalid_request_error');
    const s = this.settings();
    if (keyId && !this.gw.db.apiKeys.find((k) => k.id === keyId && k.sold)) throw new ShopError(404, 'Licence introuvable', 'not_found');
    const now = Date.now();
    const order = {
      id: `ord_${randomBytes(5).toString('hex')}`, tokenHash: sha256(randomToken(18)), reference: reference(), status: S.PENDING, contact: String(contact).slice(0, 120),
      method: Number(amountUsd) > 0 ? 'offline' : 'gift', tokens: t, amountUsd: Math.max(0, Number(amountUsd) || 0), currency: s.currency, createdAt: now, expiresAt: now + 60_000,
      topupKeyId: keyId, ipHash: 'admin', payment: {},
    };
    this.orders.push(order);
    this.ledger.event('ORDER_COMMITTED', { orderId: order.id, reference: order.reference, tokens: t, amountUsd: order.amountUsd, currency: order.currency, method: order.method, topup: !!keyId }, 'admin');
    const view = this.markPaid(order.id, { method: order.method, note, amountUsd: order.amountUsd }, 'admin');
    return { ...view, licenseKey: view.licenseKey ?? undefined, orderId: order.id };
  }

  /* ───────── Consommation ───────── */

  /** Débite le crédit d'une licence vendue après un échange réussi (hors cache). */
  charge(ex) {
    if (!ex || ex.status !== 'ok' || ex.cached) return 0;
    const name = String(ex.client ?? '').replace(/^mcp:/, '');
    const rec = this.gw.db.apiKeys.find((k) => k.sold && k.name === name);
    if (!rec) return 0;
    const f = multiplierFor(this.settings().multipliers, ex.model && String(ex.model).includes('/') ? ex.model : `${ex.provider}/${ex.model ?? ''}`);
    const n = chargeFor(ex.tokensIn, ex.tokensOut, f);
    if (n > 0) { rec.credits.used += n; this.gw.store.save(); }
    return n;
  }

  /* ───────── Compte acheteur ───────── */

  account(licenseKey) {
    const rec = this._soldKeyByToken(licenseKey);
    if (!rec) throw new ShopError(404, 'Licence introuvable', 'not_found');
    const s = this.settings();
    const since = Date.now() - 14 * DAY;
    const days = {}; const recent = [];
    const exs = this.gw.ledger.exchanges;
    for (let i = exs.length - 1; i >= 0; i -= 1) {
      const ex = exs[i];
      if (ex.ts < since) break;
      if (ex.client !== rec.name && ex.client !== `mcp:${rec.name}`) continue;
      const f = multiplierFor(s.multipliers, String(ex.model ?? '').includes('/') ? ex.model : `${ex.provider}/${ex.model ?? ''}`);
      const charged = ex.status === 'ok' && !ex.cached ? chargeFor(ex.tokensIn, ex.tokensOut, f) : 0;
      const day = new Date(ex.ts).toISOString().slice(0, 10);
      days[day] = days[day] ?? { requests: 0, tokens: 0 };
      days[day].requests += 1; days[day].tokens += charged;
      if (recent.length < 10) recent.push({ ts: ex.ts, model: ex.model, tokens: charged, status: ex.status, cached: !!ex.cached });
    }
    return {
      name: rec.name, enabled: rec.enabled !== false, balance: this.balance(rec), granted: rec.credits.granted, used: rec.credits.used,
      expiresAt: rec.expiresAt ?? null, rateLimitPerMin: rec.rateLimitPerMin || 0, usageByDay: days, recent,
      orders: this.orders.filter((o) => o.licenseKeyId === rec.id && o.status === S.DELIVERED).slice(-10).map((o) => ({ reference: o.reference, tokens: o.tokens, at: o.deliveredAt })),
      multipliers: s.multipliers,
    };
  }

  /* ───────── Administration ───────── */

  listOrders(limit = 200) {
    this._sweep();
    return this.orders.slice(-limit).reverse().map((o) => ({
      id: o.id, reference: o.reference, status: o.status, contact: o.contact, method: o.method, tokens: o.tokens, amountUsd: o.amountUsd, currency: o.currency,
      createdAt: o.createdAt, paidAt: o.paidAt ?? null, expiresAt: o.expiresAt, topup: !!o.topupKeyId, txid: o.payment?.txid ?? null, note: o.payment?.note ?? '',
    }));
  }

  listLicenses() {
    return this.gw.db.apiKeys.filter((k) => k.sold).map((k) => ({
      id: k.id, name: k.name, prefix: k.prefix, contact: k.contact, enabled: k.enabled !== false, granted: k.credits.granted, used: k.credits.used,
      balance: this.balance(k), expiresAt: k.expiresAt ?? null, lastUsedAt: k.lastUsedAt, createdAt: k.createdAt,
    }));
  }

  stats() {
    const totals = this.ledger.totals();
    const sold = this.gw.db.apiKeys.filter((k) => k.sold);
    const names = new Set(sold.flatMap((k) => [k.name, `mcp:${k.name}`]));
    let upstreamCostUsd = 0; let requests = 0;
    for (const ex of this.gw.ledger.exchanges) { if (names.has(ex.client)) { upstreamCostUsd += ex.costUsd ?? 0; requests += 1; } }
    const granted = sold.reduce((a, k) => a + k.credits.granted, 0);
    const used = sold.reduce((a, k) => a + k.credits.used, 0);
    const byStatus = {};
    for (const o of this.orders) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
    return {
      revenueUsd: totals.revenueUsd, tokensSold: totals.tokensSold, tokensConsumed: used, tokensOutstanding: Math.max(0, granted - used),
      upstreamCostUsd: Math.round(upstreamCostUsd * 10000) / 10000, marginUsd: Math.round((totals.revenueUsd - upstreamCostUsd) * 100) / 100,
      requests, licenses: sold.length, orders: byStatus, duality: this.ledger.verifyDuality(), chain: this.ledger.verify(),
    };
  }
}
