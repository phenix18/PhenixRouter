// Copyright (c) 2026 Fido-labs —kcw—
// Registre des fournisseurs à offre gratuite. Tout est déclaratif : ajouter un
// fournisseur compatible OpenAI = ajouter une entrée ici.
//
// Les listes `models` sont un REPLI statique (hors-ligne / sans clé). Dès qu'une clé
// est configurée, la découverte dynamique (discovery.js) les remplace par la liste réelle.
// Les offres gratuites évoluent vite : vérifiez toujours les conditions chez le fournisseur.

const m = (id, extra = {}) => ({ id, ...extra });

export const PROVIDERS = [
  {
    id: 'groq', alias: 'gq', name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY',
    signup: 'https://console.groq.com/keys',
    note: 'Offre gratuite, très rapide (limites par minute et par jour).',
    discovery: 'openai', speed: 'fast', priority: 10,
    models: [
      m('llama-3.3-70b-versatile', { ctx: 131072 }),
      m('llama-3.1-8b-instant', { ctx: 131072 }),
      m('openai/gpt-oss-120b', { ctx: 131072 }),
      m('openai/gpt-oss-20b', { ctx: 131072 }),
      m('meta-llama/llama-4-scout-17b-16e-instruct', { ctx: 131072 }),
    ],
  },
  {
    id: 'cerebras', alias: 'cb', name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1', keyEnv: 'CEREBRAS_API_KEY',
    signup: 'https://cloud.cerebras.ai/',
    note: 'Offre gratuite, inférence ultra-rapide.',
    discovery: 'openai', speed: 'fast', priority: 12,
    dropParams: ['logprobs', 'top_logprobs', 'presence_penalty', 'frequency_penalty', 'logit_bias', 'service_tier'],
    models: [
      m('llama-3.3-70b', { ctx: 65536 }),
      m('llama3.1-8b', { ctx: 8192 }),
      m('qwen-3-32b', { ctx: 65536 }),
      m('gpt-oss-120b', { ctx: 65536 }),
    ],
  },
  {
    id: 'openrouter', alias: 'or', name: 'OpenRouter (modèles :free)',
    baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY',
    signup: 'https://openrouter.ai/keys',
    note: 'Seuls les modèles dont le prix est 0 sont exposés (découverte dynamique).',
    discovery: 'openrouter', speed: 'medium', priority: 20,
    extraHeaders: { 'X-Title': 'PhenixRouter' },
    models: [
      m('meta-llama/llama-3.3-70b-instruct:free', { ctx: 131072 }),
      m('deepseek/deepseek-r1:free', { ctx: 163840 }),
      m('qwen/qwen3-coder:free', { ctx: 262144 }),
      m('openai/gpt-oss-20b:free', { ctx: 131072 }),
      m('google/gemma-3-27b-it:free', { ctx: 131072 }),
    ],
  },
  {
    id: 'gemini', alias: 'gm', name: 'Google Gemini (AI Studio)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY',
    signup: 'https://aistudio.google.com/apikey',
    note: 'Offre gratuite généreuse, vision et contexte long.',
    discovery: 'openai', speed: 'fast', priority: 8,
    dropParams: ['presence_penalty', 'frequency_penalty', 'logit_bias', 'store', 'service_tier'],
    models: [
      m('gemini-2.5-flash', { ctx: 1048576, tags: ['vision', 'tools'] }),
      m('gemini-2.5-flash-lite', { ctx: 1048576, tags: ['vision', 'tools'] }),
      m('gemini-2.0-flash', { ctx: 1048576, tags: ['vision', 'tools'] }),
      m('gemini-embedding-001', { tags: ['embedding'] }),
    ],
  },
  {
    id: 'mistral', alias: 'mi', name: 'Mistral (La Plateforme)',
    baseUrl: 'https://api.mistral.ai/v1', keyEnv: 'MISTRAL_API_KEY',
    signup: 'https://console.mistral.ai/api-keys',
    note: 'Palier gratuit « Experiment » avec limites strictes.',
    discovery: 'openai', speed: 'medium', priority: 30,
    dropParams: ['store', 'service_tier', 'logit_bias'],
    models: [
      m('mistral-small-latest', { ctx: 131072, tags: ['tools'] }),
      m('open-mistral-nemo', { ctx: 131072, tags: ['tools'] }),
      m('codestral-latest', { ctx: 262144, tags: ['code'] }),
      m('pixtral-12b-2409', { ctx: 131072, tags: ['vision'] }),
      m('mistral-embed', { tags: ['embedding'] }),
    ],
  },
  {
    id: 'nvidia', alias: 'nv', name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1', keyEnv: 'NVIDIA_API_KEY',
    signup: 'https://build.nvidia.com/settings/api-keys',
    note: 'Accès gratuit via NVIDIA Developer Program (limites de débit).',
    discovery: 'openai', speed: 'medium', priority: 25,
    models: [
      m('meta/llama-3.3-70b-instruct', { ctx: 131072 }),
      m('nvidia/llama-3.1-nemotron-70b-instruct', { ctx: 131072 }),
      m('deepseek-ai/deepseek-r1', { ctx: 131072 }),
      m('qwen/qwen2.5-coder-32b-instruct', { ctx: 131072 }),
      m('nvidia/nv-embed-v1', { tags: ['embedding'] }),
    ],
  },
  {
    id: 'github', alias: 'gh', name: 'GitHub Models',
    baseUrl: 'https://models.github.ai/inference', keyEnv: 'GITHUB_MODELS_TOKEN',
    signup: 'https://github.com/settings/personal-access-tokens',
    note: 'Jeton GitHub (permission « models »), limites de débit gratuites.',
    discovery: 'github', speed: 'medium', priority: 35,
    extraHeaders: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    models: [
      m('openai/gpt-4.1-mini', { ctx: 1048576, tags: ['vision', 'tools'] }),
      m('meta/llama-3.3-70b-instruct', { ctx: 131072 }),
      m('deepseek/deepseek-r1', { ctx: 131072 }),
      m('microsoft/phi-4', { ctx: 16384 }),
    ],
  },
  {
    id: 'cloudflare', alias: 'cf', name: 'Cloudflare Workers AI',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1', keyEnv: 'CLOUDFLARE_API_TOKEN',
    needs: ['accountId'], accountEnv: 'CLOUDFLARE_ACCOUNT_ID',
    signup: 'https://dash.cloudflare.com/profile/api-tokens',
    note: 'Quota gratuit quotidien (neurones). Nécessite le jeton ET l’ID de compte.',
    discovery: 'cloudflare', speed: 'medium', priority: 40,
    models: [
      m('@cf/meta/llama-3.3-70b-instruct-fp8-fast', { ctx: 24000 }),
      m('@cf/meta/llama-3.1-8b-instruct', { ctx: 7968 }),
      m('@cf/mistralai/mistral-small-3.1-24b-instruct', { ctx: 128000 }),
      m('@cf/qwen/qwq-32b', { ctx: 24000 }),
      m('@cf/baai/bge-m3', { tags: ['embedding'] }),
    ],
  },
  {
    id: 'huggingface', alias: 'hf', name: 'Hugging Face Inference',
    baseUrl: 'https://router.huggingface.co/v1', keyEnv: 'HF_TOKEN',
    signup: 'https://huggingface.co/settings/tokens',
    note: 'Crédits d’inférence gratuits mensuels.',
    discovery: 'openai', speed: 'medium', priority: 45,
    models: [
      m('Qwen/Qwen2.5-Coder-32B-Instruct', { ctx: 32768, tags: ['code'] }),
      m('meta-llama/Llama-3.3-70B-Instruct', { ctx: 131072 }),
      m('deepseek-ai/DeepSeek-R1', { ctx: 131072 }),
    ],
  },
  {
    id: 'sambanova', alias: 'sn', name: 'SambaNova Cloud',
    baseUrl: 'https://api.sambanova.ai/v1', keyEnv: 'SAMBANOVA_API_KEY',
    signup: 'https://cloud.sambanova.ai/apis',
    note: 'Palier gratuit avec limites de débit.',
    discovery: 'openai', speed: 'fast', priority: 28,
    models: [
      m('Meta-Llama-3.3-70B-Instruct', { ctx: 131072 }),
      m('DeepSeek-R1', { ctx: 32768 }),
      m('Qwen3-32B', { ctx: 32768 }),
    ],
  },
  {
    id: 'together', alias: 'tg', name: 'Together AI (modèles gratuits)',
    baseUrl: 'https://api.together.xyz/v1', keyEnv: 'TOGETHER_API_KEY',
    signup: 'https://api.together.ai/settings/api-keys',
    note: 'Seuls les modèles à tarif nul sont exposés (découverte dynamique).',
    discovery: 'together', speed: 'medium', priority: 50,
    models: [m('meta-llama/Llama-3.3-70B-Instruct-Turbo-Free', { ctx: 131072 })],
  },
  {
    id: 'cohere', alias: 'co', name: 'Cohere (clé d’essai)',
    baseUrl: 'https://api.cohere.ai/compatibility/v1', keyEnv: 'COHERE_API_KEY',
    signup: 'https://dashboard.cohere.com/api-keys',
    note: 'Clé d’essai gratuite (usage non commercial, limites de débit).',
    discovery: 'static', speed: 'medium', priority: 55,
    models: [
      m('command-a-03-2025', { ctx: 262144, tags: ['tools'] }),
      m('command-r-plus', { ctx: 131072, tags: ['tools'] }),
      m('command-r', { ctx: 131072, tags: ['tools'] }),
      m('embed-english-v3.0', { tags: ['embedding'] }),
    ],
  },
  {
    id: 'zhipu', alias: 'zp', name: 'Zhipu AI (GLM Flash)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyEnv: 'ZHIPU_API_KEY',
    signup: 'https://open.bigmodel.cn/usercenter/apikeys',
    note: 'Modèles GLM « Flash » gratuits.',
    discovery: 'static', speed: 'medium', priority: 60,
    models: [m('glm-4-flash', { ctx: 128000, tags: ['tools'] }), m('glm-4.5-flash', { ctx: 128000, tags: ['tools'] })],
  },
  {
    id: 'siliconflow', alias: 'sf', name: 'SiliconFlow (modèles gratuits)',
    baseUrl: 'https://api.siliconflow.com/v1', keyEnv: 'SILICONFLOW_API_KEY',
    signup: 'https://cloud.siliconflow.com/account/ak',
    note: 'Plusieurs petits modèles gratuits.',
    discovery: 'openai', speed: 'medium', priority: 65,
    models: [
      m('Qwen/Qwen2.5-7B-Instruct', { ctx: 32768 }),
      m('THUDM/glm-4-9b-chat', { ctx: 32768 }),
      m('deepseek-ai/DeepSeek-R1-Distill-Qwen-7B', { ctx: 32768 }),
    ],
  },
  {
    id: 'pollinations', alias: 'pl', name: 'Pollinations (sans clé)',
    baseUrl: 'https://text.pollinations.ai/openai', chatUrl: 'https://text.pollinations.ai/openai',
    keyless: true, experimental: true, images: true,
    signup: 'https://pollinations.ai/',
    note: 'Aucune clé requise. Service communautaire : disponibilité et modèles variables.',
    discovery: 'static', speed: 'slow', priority: 90,
    dropParams: ['stream_options', 'store', 'service_tier', 'logit_bias'],
    models: [m('openai', { ctx: 128000 }), m('mistral', { ctx: 32768 }), m('llama', { ctx: 32768 })],
  },
  {
    id: 'ollama', alias: 'ol', name: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1', baseEnv: 'OLLAMA_BASE_URL',
    keyless: true, local: true,
    signup: 'https://ollama.com/download',
    note: 'Vos modèles locaux. 100 % gratuit et privé.',
    discovery: 'openai', speed: 'local', priority: 70,
    dropParams: ['store', 'service_tier'],
    models: [],
  },
  {
    id: 'lmstudio', alias: 'lm', name: 'LM Studio (local)',
    baseUrl: 'http://localhost:1234/v1', baseEnv: 'LMSTUDIO_BASE_URL',
    keyless: true, local: true,
    signup: 'https://lmstudio.ai/',
    note: 'Serveur local compatible OpenAI.',
    discovery: 'openai', speed: 'local', priority: 71,
    models: [],
  },
  {
    id: 'custom', alias: 'cu', name: 'Endpoint compatible OpenAI (personnalisé)',
    baseUrl: '', custom: true, local: true, optionalKey: true,
    signup: '',
    note: 'vLLM, llama.cpp, LiteLLM, proxy d’entreprise… renseignez l’URL de base.',
    discovery: 'openai', speed: 'local', priority: 80,
    models: [],
  },
];

const byId = new Map();
for (const p of PROVIDERS) {
  byId.set(p.id, p);
  if (p.alias) byId.set(p.alias, p);
}

export const getProvider = (idOrAlias) => byId.get(String(idOrAlias).toLowerCase()) ?? null;

/** URL de base effective (substitue {accountId}, surcharges de connexion et variable d'env). */
export function resolveBaseUrl(provider, conn = {}) {
  let url = conn.baseUrl || (provider.baseEnv && process.env[provider.baseEnv]) || provider.baseUrl || '';
  url = url.replace('{accountId}', encodeURIComponent(conn.extra?.accountId ?? ''));
  return url.replace(/\/+$/, '');
}

export function chatEndpoint(provider, conn) {
  if (provider.chatUrl && !conn?.baseUrl) return provider.chatUrl;
  return `${resolveBaseUrl(provider, conn)}/chat/completions`;
}

export function endpoint(provider, conn, path) {
  return `${resolveBaseUrl(provider, conn)}${path}`;
}
