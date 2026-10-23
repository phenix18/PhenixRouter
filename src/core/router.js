// Copyright (c) 2026 Fido-labs —kcw—
// Résolution d'un nom de modèle demandé → liste ordonnée de cibles {provider, model}.
//
// Formes acceptées :
//   groq/llama-3.3-70b-versatile     fournisseur explicite (ou alias court : gq/…)
//   phenix/auto | auto               chaîne dynamique construite depuis le catalogue
//   phenix/fast|smart|code|vision|reasoning|embed
//   mon-combo                        combo défini dans le tableau de bord
//   mon-alias                        alias vers n'importe laquelle des formes ci-dessus
//   llama-3.3-70b-versatile          identifiant « nu » : tous les fournisseurs qui l'offrent
import { BRAND } from '../config.js';
import { getProvider } from '../providers/registry.js';

// free = uniquement des modèles gratuits ; best = meilleure qualité tous tarifs confondus (selon le mode de coût).
export const VIRTUAL = ['auto', 'fast', 'smart', 'code', 'vision', 'reasoning', 'embed', 'free', 'best'];

// Noms hérités / compatibles (ex. config.json de phenixRouter v3).
const BUILTIN_ALIASES = { 'phenixrouter-free': 'free', phenixrouter: 'auto' };

export function parseModel(str) {
  const s = String(str);
  const i = s.indexOf('/');
  if (i > 0) {
    const p = getProvider(s.slice(0, i));
    if (p) return { provider: p.id, model: s.slice(i + 1) };
  }
  return null;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function expandEntry(gw, entry, depth = 0) {
  const explicit = parseModel(entry);
  if (explicit) return [explicit];
  if (depth > 2) return [];
  const alias = gw.db.aliases[entry];
  if (alias) return expandEntry(gw, alias, depth + 1);
  return gw.catalog.findBare(entry).map((e) => ({ provider: e.provider, model: e.model }));
}

function dedupe(targets) {
  const seen = new Set();
  return targets.filter((t) => {
    const k = `${t.provider}/${t.model}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Chaîne dynamique : filtre par capacité, classe par qualité/latence, diversifie les fournisseurs. */
function autoChain(gw, mode, { needTools = false, needVision = false } = {}) {
  const embedding = mode === 'embed';
  const costMode = gw.settings().costMode;
  // `free` force le gratuit ; sinon on exclut les fournisseurs payants bloqués (mode gratuit seul, budget épuisé).
  const ready = gw.catalog.list().filter((e) => e.status === 'ready'
    && (mode === 'free' ? e.tier !== 'paid' : !(e.tier === 'paid' && gw.costBlock(e.provider))));
  const has = (e, tag) => e.tags.includes(tag);
  let pool = ready.filter((e) => (embedding ? has(e, 'embedding') : has(e, 'chat')));
  const strict = (list) => list.filter((e) => (!needTools || has(e, 'tools')) && (!needVision || has(e, 'vision')));
  let filtered = strict(pool);
  if (!filtered.length) filtered = pool; // relâche si aucun modèle ne porte l'étiquette

  const prefer = { code: 'code', vision: 'vision', reasoning: 'reasoning', smart: 'large' }[mode];
  if (prefer) {
    const tagged = filtered.filter((e) => has(e, prefer));
    if (tagged.length) filtered = tagged;
  }

  // « gratuit d'abord » : tous les gratuits avant le moindre payant (sauf `best`, qui classe par qualité seule).
  const tierRank = (e) => (costMode === 'any' || mode === 'best' || e.tier !== 'paid' ? 0 : 1);
  const speedRank = { local: 0, fast: 1, medium: 2, slow: 3 };
  const latencyPenalty = (e) => Math.min(30, (e.latencyMs ?? 900) / 200);
  let sorted;
  if (mode === 'fast') {
    sorted = [...filtered].sort((a, b) => (
      (speedRank[a.speed] ?? 2) - (speedRank[b.speed] ?? 2)
      || (a.latencyMs ?? 900) - (b.latencyMs ?? 900)
      || (has(b, 'small') ? 1 : 0) - (has(a, 'small') ? 1 : 0)
      || b.quality - a.quality
    ));
  } else {
    sorted = [...filtered].sort((a, b) => (b.quality - latencyPenalty(b)) - (a.quality - latencyPenalty(a)));
  }
  sorted = sorted.sort((a, b) => tierRank(a) - tierRank(b)); // tri stable : conserve l'ordre qualité/vitesse

  const size = gw.settings().autoChainSize;
  const perProvider = new Map();
  const chain = [];
  for (const e of sorted) {
    const n = perProvider.get(e.provider) ?? 0;
    if (n >= 2) continue;
    perProvider.set(e.provider, n + 1);
    chain.push({ provider: e.provider, model: e.model });
    if (chain.length >= size) break;
  }
  return chain;
}

/**
 * @returns {{targets: Array<{provider:string, model:string}>, kind:'explicit'|'combo'|'virtual'|'bare', label:string, strategy:string}}
 */
/**
 * Les outils (Claude Code, Codex, OpenCode…) envoient parfois leurs propres noms de modèle (« claude-3-5-haiku »,
 * « gpt-5-codex »…), y compris pour leurs tâches internes. Sans clé du fournisseur d'origine, on les redirige vers
 * l'alias PhenixRouter équivalent au lieu de répondre « aucun modèle ».
 */
export function foreignAlias(name) {
  const s = String(name).toLowerCase().replace(/^[\w-]+\//, '');
  if (!/^(claude|gpt|o[134]\b|chatgpt|codex|sonnet|opus|haiku)/.test(s)) return null;
  if (/haiku|mini|nano|flash|lite|instant/.test(s)) return 'fast';
  if (/codex|code/.test(s)) return 'code';
  if (/opus|\bo[134]\b|gpt-5(?!.*(mini|nano))|pro\b|reason|think/.test(s)) return 'smart';
  return 'auto';
}

export function resolveTargets(gw, requested, opts = {}) {
  let name = String(requested ?? 'auto').trim() || 'auto';
  const prefix = `${BRAND.modelPrefix}/`.toLowerCase();
  if (name.toLowerCase().startsWith(prefix)) name = name.slice(prefix.length);

  // alias → autre forme
  for (let i = 0; i < 3 && gw.db.aliases[name]; i += 1) {
    name = gw.db.aliases[name];
    if (name.toLowerCase().startsWith(prefix)) name = name.slice(prefix.length);
  }

  let lower = name.toLowerCase();
  if (BUILTIN_ALIASES[lower] && !gw.db.combos.some((c) => c.name.toLowerCase() === lower)) { lower = BUILTIN_ALIASES[lower]; name = lower; }
  const combo = gw.db.combos.find((c) => c.name.toLowerCase() === lower);
  if (combo) {
    let targets = dedupe(combo.models.flatMap((m) => expandEntry(gw, m)));
    if (combo.strategy === 'roundrobin' && targets.length > 1) {
      const k = `combo:${combo.id}`;
      const start = (gw.rr.get(k) ?? 0) % targets.length;
      gw.rr.set(k, start + 1);
      targets = [...targets.slice(start), ...targets.slice(0, start)];
    } else if (combo.strategy === 'fastest') {
      targets = [...targets].sort((a, b) => gw.providerScore(a.provider) - gw.providerScore(b.provider));
    } else if (combo.strategy === 'random') {
      targets = shuffle(targets);
    }
    return { targets, kind: 'combo', label: combo.name, strategy: combo.strategy };
  }

  if (VIRTUAL.includes(lower)) {
    const mode = opts.kind === 'embedding' ? 'embed' : lower;
    return { targets: autoChain(gw, mode, opts), kind: 'virtual', label: lower, strategy: 'auto' };
  }

  const explicit = parseModel(name);
  if (explicit) {
    const fa = foreignAlias(name);
    if (fa && ['anthropic', 'openai'].includes(explicit.provider) && gw.catalog.providerStatus(explicit.provider) === 'connect') return { targets: autoChain(gw, fa, opts), kind: 'virtual', label: fa, strategy: 'auto' };
    return { targets: [explicit], kind: 'explicit', label: name, strategy: 'single' };
  }

  const bare = gw.catalog.findBare(name)
    .sort((a, b) => (a.status === 'ready' ? 0 : 1) - (b.status === 'ready' ? 0 : 1) || (a.latencyMs ?? 9e9) - (b.latencyMs ?? 9e9));
  if (!bare.some((e) => e.status === 'ready')) {
    const fa = foreignAlias(name);
    if (fa) return { targets: autoChain(gw, fa, opts), kind: 'virtual', label: fa, strategy: 'auto' };
  }
  return {
    targets: dedupe(bare.map((e) => ({ provider: e.provider, model: e.model }))),
    kind: 'bare', label: name, strategy: 'fallback',
  };
}
