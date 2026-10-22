// Copyright (c) 2026 Fido-labs —kcw—
// PhenixRouter — configuration et marque (source unique : brand.json)
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ROOT, IS_SEA, readAsset } from './assets.js';

export { ROOT, IS_SEA };
export const BRAND = JSON.parse(readAsset('brand.json').toString('utf8'));
export const VERSION = JSON.parse(readAsset('package.json').toString('utf8')).version;

export function resolveDataDir(override) {
  return override || process.env.PHENIX_DATA_DIR || join(homedir(), `.${BRAND.slug}`);
}

/** Réglages modifiables depuis le tableau de bord (persistés dans db.json). */
export const DEFAULT_SETTINGS = Object.freeze({
  language: 'fr',
  requireApiKey: true,
  requestTimeoutMs: 120000,
  firstByteTimeoutMs: 30000,
  streamIdleTimeoutMs: 60000,
  maxAttemptsPerRequest: 8,
  cacheEnabled: true,
  cacheTtlSec: 600,
  cacheMaxEntries: 200,
  rateLimitPerMin: 0,
  corsOrigins: [],
  catalogTtlMin: 30,
  logRetention: 500,
  webTools: true,
  searxngUrl: '',
  autoChainSize: 6,
  costMode: 'freeFirst',      // freeOnly | freeFirst | any
  dailyBudgetUsd: 0,          // 0 = illimité (ne limite que les fournisseurs payants)
  monthlyBudgetUsd: 0,
  pricing: {},                // surcharges de prix : { "openai/gpt-4o": { in: 2.5, out: 10 } } (USD / M tokens)
  tokenSaver: false,          // compresse les gros résultats d'outils avant l'envoi
  tokenSaverMaxChars: 6000,
});

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
