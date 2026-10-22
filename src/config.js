// Copyright (c) 2026 Fido-labs —kcw—
// PhenixRouter — configuration et marque (source unique : brand.json)
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BRAND = JSON.parse(readFileSync(join(ROOT, 'brand.json'), 'utf8'));
export const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

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
});

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
