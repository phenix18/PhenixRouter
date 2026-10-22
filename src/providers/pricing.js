// Copyright (c) 2026 Fido-labs —kcw—
// Tarification INDICATIVE (USD par million de tokens) pour estimer le coût des fournisseurs payants.
// Les fournisseurs gratuits coûtent toujours 0. Les prix changent : ils sont modifiables dans les
// réglages (`pricing` : { "openai/gpt-4o": { "in": 2.5, "out": 10 } }) et ne remplacent pas la
// facture réelle du fournisseur.
import { getProvider } from './registry.js';

// Motifs testés dans l'ordre (le plus spécifique d'abord), par fournisseur.
const TABLE = {
  openai: [
    [/gpt-5-nano/i, 0.05, 0.4], [/gpt-5-mini/i, 0.25, 2], [/gpt-5/i, 1.25, 10],
    [/gpt-4\.1-nano/i, 0.1, 0.4], [/gpt-4\.1-mini/i, 0.4, 1.6], [/gpt-4\.1/i, 2, 8],
    [/gpt-4o-mini/i, 0.15, 0.6], [/gpt-4o/i, 2.5, 10], [/o4-mini/i, 1.1, 4.4], [/o3-mini/i, 1.1, 4.4],
    [/o3/i, 2, 8], [/o1/i, 15, 60], [/gpt-3\.5/i, 0.5, 1.5], [/embedding-3-small/i, 0.02, 0],
    [/embedding-3-large/i, 0.13, 0],
  ],
  anthropic: [[/opus/i, 15, 75], [/sonnet/i, 3, 15], [/haiku/i, 1, 5]],
  deepseek: [[/reasoner|r1/i, 0.55, 2.19], [/./, 0.27, 1.1]],
  xai: [[/grok-3-mini|mini/i, 0.3, 0.5], [/code-fast/i, 0.2, 1.5], [/./, 3, 15]],
  perplexity: [[/sonar-pro|reasoning-pro/i, 3, 15], [/./, 1, 1]],
  fireworks: [[/./, 0.9, 0.9]],
  deepinfra: [[/./, 0.3, 0.6]],
  hyperbolic: [[/./, 0.4, 0.4]],
  novita: [[/./, 0.3, 0.6]],
  moonshot: [[/./, 0.6, 2.5]],
  dashscope: [[/max/i, 1.6, 6.4], [/plus/i, 0.4, 1.2], [/./, 0.2, 0.6]],
};

/** @returns {{in:number, out:number, known:boolean, free:boolean}} */
export function priceOf(providerId, model, overrides = {}) {
  const provider = getProvider(providerId);
  if (!provider || provider.tier !== 'paid') return { in: 0, out: 0, known: true, free: true };
  const o = overrides[`${providerId}/${model}`] ?? overrides[model];
  if (o && Number.isFinite(Number(o.in)) && Number.isFinite(Number(o.out))) return { in: Number(o.in), out: Number(o.out), known: true, free: false };
  for (const [re, pin, pout] of TABLE[providerId] ?? []) if (re.test(model)) return { in: pin, out: pout, known: true, free: false };
  return { in: 0, out: 0, known: false, free: false };
}

export function estimateCost(providerId, model, tokensIn = 0, tokensOut = 0, overrides = {}) {
  const p = priceOf(providerId, model, overrides);
  return (tokensIn * p.in + tokensOut * p.out) / 1e6;
}
