// Copyright (c) 2026 Fido-labs —kcw—
// Module « Vente de tokens » (optionnel, désactivé par défaut) — modèle REA et réglages.
//
// RESSOURCES : crédit de tokens (stock vendable) · trésorerie (USDT / Mobile Money reçus) · licence (clé API prépayée)
// ÉVÉNEMENTS : ORDER_COMMITTED (engagement) · PAYMENT_RECEIVED (entrée de trésorerie) · CREDIT_GRANTED (sortie de crédit
//              vers la licence) · CREDIT_CONSUMED (REQUEST/COMPLETION du grand livre principal)
// AGENTS     : Acheteur (externe) · Boutique/Vendeur (interne) · Fournisseur amont · Passerelle de paiement (Binance Pay)
// DUALITÉ    : PAYMENT_RECEIVED ↔ CREDIT_GRANTED (même commande, même montant de tokens) — vérifiée par ShopLedger.verifyDuality()

export const ORDER_STATUS = Object.freeze({ PENDING: 'pending', PAID: 'paid', DELIVERED: 'delivered', EXPIRED: 'expired', CANCELED: 'canceled' });

export const DEFAULT_SHOP = Object.freeze({
  enabled: false,
  brandName: 'PhenixRouter',
  currency: 'USDT',
  pricePerMillionUsd: 3,                 // 1 000 000 tokens = 3 USD (modifiable)
  packs: [
    { id: 'p1', tokens: 1_000_000, priceUsd: 3 },
    { id: 'p5', tokens: 5_000_000, priceUsd: 15 },
    { id: 'p10', tokens: 10_000_000, priceUsd: 30 },
  ],
  allowCustomAmount: true,               // quantité libre en millions de tokens, au prix unitaire
  minMillions: 1,
  maxMillions: 1000,
  multipliers: {},                       // coût en tokens selon le modèle : { "openai/*": 5, "groq/*": 1 }
  publicUrl: '',                         // URL publique (tunnel / domaine) affichée dans les configurations des clients
  contact: '',                           // WhatsApp / e-mail d'assistance affiché sur la boutique
  allowRemoteAdmin: false,
  notice: '',                            // message libre affiché sur la boutique
  orderTtlMin: 60,                       // durée de validité d'une commande non payée
  licenseValidityDays: 0,                // 0 = la licence n'expire jamais
  soldKeyRateLimitPerMin: 60,            // limite de débit des licences vendues (partage abusif)
  methods: {
    manual: { enabled: true, label: 'Binance (transfert USDT / Pay ID)', instructions: 'Envoyez exactement {amount} {currency} (réseau BEP20/TRC20 ou Binance Pay ID indiqué par le vendeur), en précisant la référence {reference} en note. Votre licence est remise dès confirmation du paiement.' },
    binancepay: { enabled: false, label: 'Binance Pay', apiKey: '', secret: '', baseUrl: 'https://bpay.binanceapi.com' },
  },
});

const clampNum = (v, min, max, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const str = (v, max) => String(v ?? '').slice(0, max);

/** Normalise un patch de réglages (secrets Binance : conservés tels quels si le champ est vide). */
export function normalizeShop(patch, current = DEFAULT_SHOP) {
  const out = { ...current };
  const p = patch ?? {};
  if (p.enabled != null) out.enabled = !!p.enabled;
  if (p.brandName != null) out.brandName = str(p.brandName, 60) || 'PhenixRouter';
  if (p.currency != null) out.currency = ['USDT', 'USDC', 'BUSD', 'USD'].includes(p.currency) ? p.currency : 'USDT';
  if (p.pricePerMillionUsd != null) out.pricePerMillionUsd = clampNum(p.pricePerMillionUsd, 0.01, 100000, current.pricePerMillionUsd);
  if (Array.isArray(p.packs)) {
    out.packs = p.packs.slice(0, 12).map((x, i) => ({
      id: /^[a-z0-9_-]{1,16}$/i.test(x?.id) ? x.id : `p${i + 1}`,
      tokens: Math.round(clampNum(x?.tokens, 1000, 1e12, 1_000_000)),
      priceUsd: Math.round(clampNum(x?.priceUsd, 0.01, 1e7, 3) * 100) / 100,
    })).filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i);
  }
  if (p.allowCustomAmount != null) out.allowCustomAmount = !!p.allowCustomAmount;
  if (p.minMillions != null) out.minMillions = clampNum(p.minMillions, 0.1, 1e6, 1);
  if (p.maxMillions != null) out.maxMillions = clampNum(p.maxMillions, out.minMillions, 1e6, 1000);
  if (p.multipliers && typeof p.multipliers === 'object') {
    out.multipliers = {};
    for (const [k, v] of Object.entries(p.multipliers).slice(0, 100)) {
      if (/^[\w.:@/*+-]{1,120}$/.test(k)) out.multipliers[k] = clampNum(v, 0.1, 1000, 1);
    }
  }
  if (p.publicUrl != null) out.publicUrl = /^https?:\/\/[^\s]+$/.test(String(p.publicUrl).trim()) ? String(p.publicUrl).trim().replace(/\/+$/, '') : '';
  if (p.contact != null) out.contact = str(p.contact, 120);
  if (p.allowRemoteAdmin != null) out.allowRemoteAdmin = !!p.allowRemoteAdmin;
  if (p.notice != null) out.notice = str(p.notice, 400);
  if (p.orderTtlMin != null) out.orderTtlMin = Math.round(clampNum(p.orderTtlMin, 5, 10080, 60));
  if (p.licenseValidityDays != null) out.licenseValidityDays = Math.round(clampNum(p.licenseValidityDays, 0, 3650, 0));
  if (p.soldKeyRateLimitPerMin != null) out.soldKeyRateLimitPerMin = Math.round(clampNum(p.soldKeyRateLimitPerMin, 0, 100000, 60));
  if (p.methods && typeof p.methods === 'object') {
    out.methods = { manual: { ...current.methods.manual }, binancepay: { ...current.methods.binancepay } };
    const m = p.methods.manual;
    if (m) {
      if (m.enabled != null) out.methods.manual.enabled = !!m.enabled;
      if (m.label != null) out.methods.manual.label = str(m.label, 80);
      if (m.instructions != null) out.methods.manual.instructions = str(m.instructions, 1500);
    }
    const b = p.methods.binancepay;
    if (b) {
      if (b.enabled != null) out.methods.binancepay.enabled = !!b.enabled;
      if (b.label != null) out.methods.binancepay.label = str(b.label, 80);
      if (b.apiKey) out.methods.binancepay.apiKey = str(b.apiKey, 200);
      if (b.secret) out.methods.binancepay.secret = str(b.secret, 200);
      if (b.baseUrl != null) out.methods.binancepay.baseUrl = /^https?:\/\//.test(b.baseUrl) ? String(b.baseUrl).replace(/\/+$/, '') : current.methods.binancepay.baseUrl;
    }
  }
  return out;
}

/** Facteur de consommation d'un modèle (« provider/model »), 1 par défaut. */
export function multiplierFor(multipliers, providerModel) {
  let best = 1; let bestLen = -1;
  for (const [pat, f] of Object.entries(multipliers ?? {})) {
    const hit = pat === '*' ? true : pat.endsWith('*') ? providerModel.startsWith(pat.slice(0, -1)) : providerModel === pat;
    const len = pat === '*' ? 0 : pat.replace(/\*$/, '').length;
    if (hit && len > bestLen) { best = f; bestLen = len; }
  }
  return best;
}

/** Tokens facturés pour un échange (entrée + sortie) × facteur du modèle. */
export const chargeFor = (tokensIn, tokensOut, factor = 1) => Math.max(0, Math.ceil(((Number(tokensIn) || 0) + (Number(tokensOut) || 0)) * factor));

/** Prix d'une commande : pack existant, ou quantité libre au prix unitaire. */
export function priceOrder(shop, { packId, millions }) {
  if (packId) {
    const pack = shop.packs.find((x) => x.id === packId);
    if (!pack) throw new Error('Pack inconnu');
    return { tokens: pack.tokens, amountUsd: pack.priceUsd };
  }
  if (!shop.allowCustomAmount) throw new Error('Choisissez un pack');
  const m = Number(millions);
  if (!Number.isFinite(m) || m < shop.minMillions || m > shop.maxMillions) throw new Error(`Quantité : entre ${shop.minMillions} et ${shop.maxMillions} millions de tokens`);
  return { tokens: Math.round(m * 1_000_000), amountUsd: Math.round(m * shop.pricePerMillionUsd * 100) / 100 };
}
