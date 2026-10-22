// Copyright (c) 2026 Fido-labs —kcw—
// Accès aux fichiers embarqués (brand.json, package.json, public/**) : depuis le disque en
// développement, depuis l'exécutable autonome (Node SEA) une fois compilé avec `npm run build:exe`.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let sea = null;
try {
  const m = typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sea') : createRequire(import.meta.url)('node:sea');
  if (m?.isSea?.()) sea = m;
} catch { /* Node sans module SEA : mode disque */ }

export const IS_SEA = !!sea;
export const ROOT = IS_SEA ? dirname(process.execPath) : join(dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} rel chemin relatif à la racine du projet, séparateur « / » (ex. « public/app.js ») */
export function readAsset(rel) {
  if (sea) return Buffer.from(sea.getAsset(rel));
  return readFileSync(join(ROOT, rel));
}
