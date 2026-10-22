// Copyright (c) 2026 Fido-labs —kcw—
// Import d'un config.json « phenixRouter v3 » (proxy Python) : reprend les comptes avec une vraie clé.
// La clé admin par défaut du fichier n'est volontairement PAS importée (mot de passe public connu).
import { getProvider } from '../providers/registry.js';

const PROVIDER_MAP = { google: 'gemini' };
const PLACEHOLDER = /A_REMPACER|A_REMPLACER|YOUR_|CHANGE_?ME|XXXX/i;

const isRealKey = (k) => typeof k === 'string' && k.trim().length >= 10 && !PLACEHOLDER.test(k);

/** @returns {{imported:number, skipped:Array<{id:string, reason:string}>}} */
export function importLegacyConfig(gw, cfg) {
  const accounts = Array.isArray(cfg?.accounts) ? cfg.accounts : [];
  const skipped = [];
  let imported = 0;
  const existing = new Set(gw.db.connections.map((c) => `${c.provider}:${c.name}`));
  for (const a of accounts) {
    const id = String(a?.id ?? '?');
    const providerId = PROVIDER_MAP[String(a?.provider ?? '').toLowerCase()] ?? String(a?.provider ?? '').toLowerCase();
    const provider = getProvider(providerId);
    if (!provider) { skipped.push({ id, reason: `fournisseur inconnu « ${a?.provider} »` }); continue; }
    if (!isRealKey(a.api_key)) { skipped.push({ id, reason: 'clé vide ou à remplacer' }); continue; }
    const name = id.slice(0, 60);
    if (existing.has(`${provider.id}:${name}`)) { skipped.push({ id, reason: 'déjà importé' }); continue; }
    try {
      gw.addConnection({ provider: provider.id, name, apiKey: a.api_key, priority: a.priority });
      if (a.active === false) gw.updateConnection(gw.db.connections.at(-1).id, { enabled: false });
      existing.add(`${provider.id}:${name}`);
      imported += 1;
    } catch (e) {
      skipped.push({ id, reason: String(e.message ?? e) });
    }
  }
  return { imported, skipped };
}
