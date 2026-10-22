// Copyright (c) 2026 Fido-labs —kcw—
// Découverte dynamique des modèles disponibles chez chaque fournisseur.
import { endpoint, resolveBaseUrl } from './registry.js';
import { inferTags } from './tags.js';

const NON_CHAT = /(whisper|tts|speech|transcri|moderation|safeguard|guard|orpheus|playai|dall-e|imagen|stable-diffusion|flux)/i;
const clean = (id) => String(id).replace(/^models\//, '');

function headersFor(provider, key) {
  const h = { accept: 'application/json', ...(provider.extraHeaders ?? {}) };
  if (key) h.authorization = `Bearer ${key}`;
  return h;
}

async function getJson(url, headers, timeoutMs, fetchFn = fetch) {
  const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const isZero = (v) => v != null && Number(v) === 0;

/**
 * @returns {Promise<Array<{model:string, ctx:number|null, tags:string[], name?:string}>>}
 */
export async function discoverModels(provider, conn, key, { timeoutMs = 8000, fetchFn = fetch } = {}) {
  const headers = headersFor(provider, key);
  switch (provider.discovery) {
    case 'openai': {
      const json = await getJson(endpoint(provider, conn, '/models'), headers, timeoutMs, fetchFn);
      const list = Array.isArray(json) ? json : json.data ?? json.models ?? [];
      return list
        .map((x) => (typeof x === 'string' ? { id: x } : x))
        .filter((x) => x?.id && !NON_CHAT.test(String(x.id)))
        .map((x) => ({
          model: clean(x.id),
          ctx: x.context_length ?? x.context_window ?? x.max_context_length ?? null,
          tags: inferTags(clean(x.id)),
        }));
    }
    case 'openrouter': {
      const json = await getJson(endpoint(provider, conn, '/models'), headers, timeoutMs, fetchFn);
      return (json.data ?? [])
        .filter((x) => x?.id && isZero(x.pricing?.prompt) && isZero(x.pricing?.completion))
        .filter((x) => !(x.architecture?.output_modalities ?? ['text']).every((o) => o !== 'text'))
        .map((x) => {
          const params = x.supported_parameters ?? [];
          const inputs = x.architecture?.input_modalities ?? [];
          const tags = inferTags(x.id, { tools: params.length ? params.includes('tools') : undefined });
          if (inputs.includes('image')) tags.push('vision');
          return { model: x.id, name: x.name, ctx: x.context_length ?? null, tags: [...new Set(tags)] };
        });
    }
    case 'together': {
      const json = await getJson(endpoint(provider, conn, '/models'), headers, timeoutMs, fetchFn);
      const list = Array.isArray(json) ? json : json.data ?? [];
      return list
        .filter((x) => x?.id && isZero(x.pricing?.input) && isZero(x.pricing?.output) && ['chat', 'language', 'embedding', undefined].includes(x.type))
        .map((x) => ({
          model: x.id,
          name: x.display_name,
          ctx: x.context_length ?? null,
          tags: x.type === 'embedding' ? ['embedding'] : inferTags(x.id),
        }));
    }
    case 'github': {
      const json = await getJson('https://models.github.ai/catalog/models', headersFor(provider, key), timeoutMs, fetchFn);
      return (Array.isArray(json) ? json : [])
        .filter((x) => x?.id)
        .filter((x) => (x.supported_output_modalities ?? ['text']).includes('text'))
        .map((x) => {
          const caps = x.capabilities ?? [];
          const tags = inferTags(x.id, { tools: caps.includes('tool-calling') });
          if ((x.supported_input_modalities ?? []).includes('image')) tags.push('vision');
          return { model: x.id, name: x.name, ctx: x.limits?.max_input_tokens ?? null, tags: [...new Set(tags)] };
        });
    }
    case 'cloudflare': {
      const base = resolveBaseUrl(provider, conn).replace(/\/ai\/v1$/, '/ai');
      const out = [];
      for (const task of ['Text%20Generation', 'Text%20Embeddings']) {
        const json = await getJson(`${base}/models/search?task=${task}&per_page=100`, headersFor(provider, key), timeoutMs, fetchFn);
        for (const x of json.result ?? []) {
          if (!x?.name) continue;
          out.push({
            model: x.name,
            ctx: null,
            tags: task.startsWith('Text%20Emb') ? ['embedding'] : inferTags(x.name),
          });
        }
      }
      return out;
    }
    default:
      return [];
  }
}

/** Repli statique du registre (hors-ligne ou sans clé). */
export function staticModels(provider) {
  return (provider.models ?? []).map((x) => ({
    model: x.id,
    ctx: x.ctx ?? null,
    tags: inferTags(x.id, { tags: x.tags }),
  }));
}
