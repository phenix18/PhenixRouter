// Copyright (c) 2026 Fido-labs —kcw—
// Moyens de paiement : « manual » (virement Binance / USDT / Mobile Money confirmé par l'administrateur) et
// « binancepay » (API marchand Binance Pay). Le statut Binance Pay est TOUJOURS revérifié par un appel signé
// à l'API : un webhook seul ne crédite jamais un compte (il ne fait que déclencher cette vérification).
import { createHmac, randomBytes } from 'node:crypto';

const hex = () => randomBytes(16).toString('hex').slice(0, 32);

/** Signature Binance Pay : HMAC-SHA512(timestamp \n nonce \n corps \n) en hexadécimal majuscule. */
export function binanceSignature(secret, timestamp, nonce, body) {
  return createHmac('sha512', secret).update(`${timestamp}\n${nonce}\n${body}\n`).digest('hex').toUpperCase();
}

async function bpayCall(cfg, path, payload, fetchFn = fetch) {
  const body = JSON.stringify(payload);
  const ts = String(Date.now());
  const nonce = hex();
  const res = await fetchFn(`${cfg.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'BinancePay-Timestamp': ts, 'BinancePay-Nonce': nonce,
      'BinancePay-Certificate-SN': cfg.apiKey, 'BinancePay-Signature': binanceSignature(cfg.secret, ts, nonce, body),
    },
    body, signal: AbortSignal.timeout(12000),
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  if (!res.ok || json?.status !== 'SUCCESS') {
    throw new Error(`Binance Pay : ${json?.errorMessage ?? json?.code ?? `HTTP ${res.status}`}`);
  }
  return json.data;
}

export const tradeNo = (order) => `PHX${order.id.replace(/[^A-Za-z0-9]/g, '')}`.slice(0, 32);

export const binancepay = {
  configured: (cfg) => !!(cfg?.enabled && cfg.apiKey && cfg.secret),

  async createOrder(cfg, order, { description, returnUrl, webhookUrl } = {}, fetchFn = fetch) {
    const payload = {
      env: { terminalType: 'WEB' },
      merchantTradeNo: tradeNo(order),
      orderAmount: Number(order.amountUsd.toFixed(2)),
      currency: order.currency === 'USD' ? 'USDT' : order.currency,
      description: String(description ?? 'Tokens API').slice(0, 256),
      goodsDetails: [{ goodsType: '02', goodsCategory: 'Z000', referenceGoodsId: order.id, goodsName: `${order.tokens} tokens` }],
      ...(returnUrl ? { returnUrl } : {}),
      ...(webhookUrl ? { webhookUrl } : {}),
    };
    const d = await bpayCall(cfg, '/binancepay/openapi/v3/order', payload, fetchFn);
    return { prepayId: d.prepayId, checkoutUrl: d.checkoutUrl ?? d.universalUrl ?? null, deeplink: d.deeplink ?? null, qrcodeLink: d.qrcodeLink ?? null, expireTime: d.expireTime ?? null };
  },

  /** Renvoie { status: 'PAID'|'PENDING'|'EXPIRED'|'CANCELED'|…, amount?, currency? } — état faisant foi (appel signé). */
  async queryOrder(cfg, order, fetchFn = fetch) {
    const d = await bpayCall(cfg, '/binancepay/openapi/v2/order/query', { merchantTradeNo: tradeNo(order) }, fetchFn);
    return { status: String(d.status ?? '').toUpperCase(), amount: d.orderAmount != null ? Number(d.orderAmount) : null, currency: d.currency ?? null };
  },
};
