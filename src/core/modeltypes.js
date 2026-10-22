// Copyright (c) 2026 Fido-labs —kcw—
// Catalogues par capacité (comme FlagshipRouter) : /v1/models/{image,tts,stt,embedding,web,video,image-to-text}
// et /v1/models/info?id=… (paramètres acceptés).
import { PROVIDERS } from '../providers/registry.js';
import { BRAND } from '../config.js';

const MODEL_TYPES = ['chat', 'llm', 'image', 'tts', 'stt', 'embedding', 'web', 'video', 'image-to-text', 'vision'];

const ready = (gw, p) => gw.configuredConnections(p.id).length > 0;

function entry(gw, p, id, kind, extra = {}) {
  return { id, object: 'model', created: Math.floor(gw.startedAt / 1000), owned_by: p?.id ?? BRAND.slug, kind, tier: p?.tier ?? 'free', free: (p?.tier ?? 'free') !== 'paid', ...extra };
}

export function listByType(gw, type, all = false) {
  const out = [];
  const created = Math.floor(gw.startedAt / 1000);
  const want = (p) => all || ready(gw, p);
  if (type === 'image') {
    for (const p of PROVIDERS.filter((x) => x.image && want(x))) out.push(entry(gw, p, `${p.id}/${p.image.model || 'default'}`, 'image'));
  } else if (type === 'video') {
    for (const p of PROVIDERS.filter((x) => x.video && want(x))) out.push(entry(gw, p, `${p.id}/${p.video.model || 'default'}`, 'video'));
  } else if (type === 'tts') {
    for (const p of PROVIDERS.filter((x) => x.audio?.tts && want(x))) out.push(entry(gw, p, `${p.id}/${p.audio.tts}`, 'tts'));
  } else if (type === 'stt') {
    for (const p of PROVIDERS.filter((x) => x.audio?.stt && want(x))) out.push(entry(gw, p, `${p.id}/${p.audio.stt}`, 'stt'));
  } else if (type === 'embedding') {
    for (const e of gw.catalog.list()) if (e.tags?.includes('embedding') && (all || e.status === 'ready')) out.push({ id: e.id, object: 'model', created, owned_by: e.provider, kind: 'embedding', tier: e.tier, free: e.tier !== 'paid' });
  } else if (type === 'image-to-text' || type === 'vision') {
    for (const e of gw.catalog.list()) if (e.tags?.includes('vision') && (all || e.status === 'ready')) out.push({ id: e.id, object: 'model', created, owned_by: e.provider, kind: 'image-to-text', tier: e.tier, free: e.tier !== 'paid' });
  } else if (type === 'web') {
    for (const p of PROVIDERS.filter((x) => (x.search || x.fetch) && want(x))) {
      if (p.search) out.push(entry(gw, p, `${p.id}/search`, 'webSearch'));
      if (p.fetch) out.push(entry(gw, p, `${p.id}/fetch`, 'webFetch'));
    }
    const b = (id, kind) => ({ id, object: 'model', created, owned_by: BRAND.slug, kind, tier: 'free', free: true });
    out.push(b('duckduckgo/search', 'webSearch'), b('direct/fetch', 'webFetch'), b('jina-reader/fetch', 'webFetch'));
    out.push({ ...b('search-combo', 'webSearch'), owned_by: 'combo' }, { ...b('fetch-combo', 'webFetch'), owned_by: 'combo' });
  }
  return { object: 'list', data: out };
}

const PARAMS = {
  image: { prompt: 'string (requis)', n: '1-4', size: '256x256 … 2048x2048', response_format: 'url | b64_json (ou ?response_format=binary)', quality: 'OpenAI', style: 'OpenAI / Stability', negative_prompt: 'Stability / SD WebUI', steps: 'SD WebUI' },
  video: { prompt: 'string (requis)', duration: 'secondes', aspect_ratio: '16:9 | 9:16 | 1:1 …', image: 'image-vers-vidéo (URL)' , note: 'Création asynchrone : suivre avec GET /v1/videos/{id}' },
  tts: { input: 'texte à lire (requis)', model: '<voix> ou <modèle>/<voix>', voice: 'selon le fournisseur', note: '?response_format=mp3 (défaut) | json' },
  stt: { file: 'multipart (requis)', language: 'ISO-639-1', prompt: 'indice', response_format: 'json | text | verbose_json | srt | vtt (selon fournisseur)', temperature: '0-1' },
  embedding: { input: 'string | string[] (requis)', encoding_format: 'float | base64', dimensions: 'OpenAI v3 seulement' },
  webSearch: { query: 'string (requis)', max_results: '1-20 (défaut 5)', search_type: 'web | news', country: 'selon fournisseur', language: 'selon fournisseur', domain_filter: 'string[]' },
  webFetch: { url: 'http(s) (requis)', format: 'markdown | text | html', max_characters: 'troncature (0 = illimité)' },
};

export function modelInfo(gw, id) {
  for (const type of ['image', 'video', 'tts', 'stt', 'embedding', 'web', 'image-to-text']) {
    const found = listByType(gw, type, true).data.find((m) => m.id === id);
    if (found) return { ...found, params: PARAMS[found.kind] ?? {}, note: 'Un autre modèle du même fournisseur peut être demandé sous la forme « fournisseur/modèle ».' };
  }
  return null;
}
