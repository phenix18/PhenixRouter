// Copyright (c) 2026 Fido-labs —kcw—
// Fournisseurs supplémentaires (compatibles OpenAI) et capacités d'IMAGE.
// Les listes de modèles sont découvertes en direct dès qu'une clé est fournie ; le repli statique
// est volontairement court. Vérifiez conditions et tarifs chez chaque fournisseur.
const m = (id, extra = {}) => ({ id, ...extra });
const paid = { tier: 'paid' };

export const EXTRA_PROVIDERS = [
  {
    id: 'codestral', alias: 'cs', name: 'Mistral Codestral (clé gratuite dédiée)',
    baseUrl: 'https://codestral.mistral.ai/v1', keyEnv: 'CODESTRAL_API_KEY',
    signup: 'https://console.mistral.ai/codestral', note: 'Clé Codestral gratuite (usage code), distincte de la clé La Plateforme.',
    discovery: 'static', speed: 'fast', priority: 28,
    models: [m('codestral-latest', { ctx: 256000, tags: ['code'] })],
  },
  {
    id: 'llm7', alias: 'l7', name: 'LLM7.io (sans clé)',
    baseUrl: 'https://api.llm7.io/v1', keyless: true, experimental: true,
    signup: 'https://llm7.io/', note: 'Passerelle communautaire gratuite sans clé : disponibilité variable.',
    discovery: 'openai', speed: 'slow', priority: 92, models: [],
  },
  {
    id: 'ovhcloud', alias: 'ov', name: 'OVHcloud AI Endpoints',
    baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', keyEnv: 'OVH_AI_ENDPOINTS_ACCESS_TOKEN', optionalKey: true, experimental: true,
    signup: 'https://endpoints.ai.cloud.ovh.net/', note: 'Accès anonyme limité en débit ; une clé relève les limites. Hébergé en Europe.',
    discovery: 'openai', speed: 'medium', priority: 55, models: [],
  },
  {
    id: 'openrouter-pro', alias: 'op', name: 'OpenRouter (tous les modèles, payant)', ...paid,
    baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_PRO_API_KEY',
    signup: 'https://openrouter.ai/keys', note: 'Catalogue complet (payant) : GPT, Claude, Gemini, Llama… Utilisez une clé distincte du compte gratuit.',
    discovery: 'openai', speed: 'medium', priority: 48, extraHeaders: { 'X-Title': 'PhenixRouter' }, models: [],
  },
  {
    id: 'vercel-gateway', alias: 'vg', name: 'Vercel AI Gateway (payant)', ...paid,
    baseUrl: 'https://ai-gateway.vercel.sh/v1', keyEnv: 'AI_GATEWAY_API_KEY',
    signup: 'https://vercel.com/ai-gateway', note: 'Un point d’accès pour de nombreux modèles (crédit mensuel offert selon le compte).',
    discovery: 'openai', speed: 'medium', priority: 52, models: [],
  },
  {
    id: 'chutes', alias: 'ch', name: 'Chutes (payant)', ...paid,
    baseUrl: 'https://llm.chutes.ai/v1', keyEnv: 'CHUTES_API_KEY', signup: 'https://chutes.ai/', note: 'Modèles ouverts, tarifs bas.',
    discovery: 'openai', speed: 'medium', priority: 56, models: [],
  },
  {
    id: 'nebius', alias: 'nb', name: 'Nebius AI Studio (payant)', ...paid,
    baseUrl: 'https://api.studio.nebius.com/v1', keyEnv: 'NEBIUS_API_KEY', signup: 'https://studio.nebius.com/', note: 'Modèles ouverts rapides.',
    discovery: 'openai', speed: 'fast', priority: 56, models: [],
  },
  {
    id: 'scaleway', alias: 'sw', name: 'Scaleway Generative APIs (payant)', ...paid,
    baseUrl: 'https://api.scaleway.ai/v1', keyEnv: 'SCALEWAY_API_KEY', signup: 'https://console.scaleway.com/generative-api/models', note: 'Hébergé en Europe ; crédit de départ possible.',
    discovery: 'openai', speed: 'medium', priority: 57, models: [],
  },
  {
    id: 'kluster', alias: 'kl', name: 'Kluster.ai (payant)', ...paid,
    baseUrl: 'https://api.kluster.ai/v1', keyEnv: 'KLUSTER_API_KEY', signup: 'https://platform.kluster.ai/', note: 'Inférence à bas coût.',
    discovery: 'openai', speed: 'medium', priority: 58, models: [],
  },
  {
    id: 'baseten', alias: 'bt', name: 'Baseten Model APIs (payant)', ...paid,
    baseUrl: 'https://inference.baseten.co/v1', keyEnv: 'BASETEN_API_KEY', signup: 'https://app.baseten.co/', note: '',
    discovery: 'openai', speed: 'fast', priority: 58, models: [],
  },
  {
    id: 'lambda', alias: 'lb', name: 'Lambda Inference (payant)', ...paid,
    baseUrl: 'https://api.lambda.ai/v1', keyEnv: 'LAMBDA_API_KEY', signup: 'https://cloud.lambda.ai/api-keys', note: '',
    discovery: 'openai', speed: 'fast', priority: 58, models: [],
  },
  {
    id: 'featherless', alias: 'fl', name: 'Featherless AI (payant)', ...paid,
    baseUrl: 'https://api.featherless.ai/v1', keyEnv: 'FEATHERLESS_API_KEY', signup: 'https://featherless.ai/', note: 'Des milliers de modèles Hugging Face.',
    discovery: 'openai', speed: 'slow', priority: 62, models: [],
  },
  {
    id: 'friendli', alias: 'fr', name: 'FriendliAI Serverless (payant)', ...paid,
    baseUrl: 'https://api.friendli.ai/serverless/v1', keyEnv: 'FRIENDLI_TOKEN', signup: 'https://friendli.ai/suite', note: '',
    discovery: 'openai', speed: 'fast', priority: 60, models: [],
  },
  {
    id: 'venice', alias: 've', name: 'Venice AI (payant)', ...paid,
    baseUrl: 'https://api.venice.ai/api/v1', keyEnv: 'VENICE_API_KEY', signup: 'https://venice.ai/settings/api', note: 'Orienté confidentialité.',
    discovery: 'openai', speed: 'medium', priority: 62, models: [],
  },
  {
    id: 'ai21', alias: 'a2', name: 'AI21 Jamba (payant)', ...paid,
    baseUrl: 'https://api.ai21.com/studio/v1', keyEnv: 'AI21_API_KEY', signup: 'https://studio.ai21.com/account/api-key', note: 'Contexte très long (Jamba).',
    discovery: 'static', speed: 'medium', priority: 64, models: [m('jamba-large', { ctx: 256000 }), m('jamba-mini', { ctx: 256000 })],
  },
  {
    id: 'upstage', alias: 'up', name: 'Upstage Solar (payant)', ...paid,
    baseUrl: 'https://api.upstage.ai/v1', keyEnv: 'UPSTAGE_API_KEY', signup: 'https://console.upstage.ai/', note: '',
    discovery: 'static', speed: 'medium', priority: 64, models: [m('solar-pro2', { ctx: 65536 })],
  },
  {
    id: 'inception', alias: 'in', name: 'Inception Mercury (payant)', ...paid,
    baseUrl: 'https://api.inceptionlabs.ai/v1', keyEnv: 'INCEPTION_API_KEY', signup: 'https://platform.inceptionlabs.ai/', note: 'Modèles à diffusion, très rapides.',
    discovery: 'static', speed: 'fast', priority: 60, models: [m('mercury-coder', { ctx: 128000, tags: ['code'] })],
  },
  {
    id: 'minimax', alias: 'mx', name: 'MiniMax (payant)', ...paid,
    baseUrl: 'https://api.minimax.io/v1', keyEnv: 'MINIMAX_API_KEY', signup: 'https://platform.minimax.io/', note: '',
    discovery: 'static', speed: 'medium', priority: 60, models: [m('MiniMax-M2', { ctx: 200000, tags: ['reasoning', 'tools'] })],
  },
  {
    id: 'stepfun', alias: 'st', name: 'StepFun (payant)', ...paid,
    baseUrl: 'https://api.stepfun.com/v1', keyEnv: 'STEPFUN_API_KEY', signup: 'https://platform.stepfun.com/', note: '',
    discovery: 'openai', speed: 'medium', priority: 64, models: [],
  },
  {
    id: 'jina', alias: 'jn', name: 'Jina AI (embeddings, clé gratuite)',
    baseUrl: 'https://api.jina.ai/v1', keyEnv: 'JINA_API_KEY', signup: 'https://jina.ai/?sui=apikey',
    note: 'Embeddings (jina-embeddings-v3) avec jetons gratuits à l’inscription.',
    discovery: 'static', speed: 'fast', priority: 30,
    models: [m('jina-embeddings-v3', { tags: ['embedding'] })],
  },
  {
    id: 'voyage', alias: 'vy', name: 'Voyage AI (embeddings)', ...paid,
    baseUrl: 'https://api.voyageai.com/v1', keyEnv: 'VOYAGE_API_KEY', signup: 'https://dash.voyageai.com/', note: 'Embeddings et rerank de haute qualité (quota gratuit à l’inscription).',
    discovery: 'static', speed: 'fast', priority: 40,
    models: [m('voyage-3.5', { tags: ['embedding'] }), m('voyage-code-3', { tags: ['embedding', 'code'] })],
  },

  {
    id: 'deepgram', alias: 'dg', name: 'Deepgram (transcription + voix)', mediaOnly: true,
    baseUrl: 'https://api.deepgram.com/v1', keyEnv: 'DEEPGRAM_API_KEY', signup: 'https://console.deepgram.com/',
    note: 'Crédit gratuit à l’inscription : transcription Nova-3 et synthèse Aura.', speed: 'fast', priority: 20, models: [],
    audio: { stt: 'nova-3', sttKind: 'deepgram', tts: 'aura-2-thalia-en', ttsKind: 'deepgram' },
  },
  {
    id: 'elevenlabs', alias: 'el', name: 'ElevenLabs (voix)', mediaOnly: true,
    baseUrl: 'https://api.elevenlabs.io/v1', keyEnv: 'ELEVENLABS_API_KEY', signup: 'https://elevenlabs.io/app/settings/api-keys',
    note: 'Synthèse vocale de haute qualité ; quota gratuit mensuel.', speed: 'medium', priority: 24, models: [],
    audio: { tts: '21m00Tcm4TlvDq8ikWAM', ttsKind: 'elevenlabs' },
  },
  // ── Recherche / lecture web (clés gratuites ou payantes ; pas de chat) ──
  {
    id: 'tavily', alias: 'tv', name: 'Tavily (recherche + extraction web)', mediaOnly: true,
    baseUrl: 'https://api.tavily.com', keyEnv: 'TAVILY_API_KEY', signup: 'https://app.tavily.com/',
    note: 'Recherche pour agents IA ; ~1000 requêtes gratuites par mois.', speed: 'fast', priority: 10, models: [],
    search: { kind: 'tavily' }, fetch: { kind: 'tavily' },
  },
  {
    id: 'brave', alias: 'bv', name: 'Brave Search API', mediaOnly: true,
    baseUrl: 'https://api.search.brave.com/res/v1', keyEnv: 'BRAVE_API_KEY', signup: 'https://brave.com/search/api/',
    note: 'Index indépendant ; offre gratuite limitée (selon le compte).', speed: 'fast', priority: 12, models: [],
    search: { kind: 'brave' },
  },
  {
    id: 'serper', alias: 'sp', name: 'Serper (résultats Google)', mediaOnly: true,
    baseUrl: 'https://google.serper.dev', keyEnv: 'SERPER_API_KEY', signup: 'https://serper.dev/',
    note: '2 500 requêtes gratuites à l’inscription.', speed: 'fast', priority: 14, models: [],
    search: { kind: 'serper' },
  },
  {
    id: 'linkup', alias: 'lk', name: 'Linkup (recherche)', mediaOnly: true,
    baseUrl: 'https://api.linkup.so/v1', keyEnv: 'LINKUP_API_KEY', signup: 'https://app.linkup.so/',
    note: 'Recherche web pour agents ; crédit gratuit mensuel.', speed: 'medium', priority: 16, models: [],
    search: { kind: 'linkup' },
  },
  {
    id: 'google-pse', alias: 'gp', name: 'Google Programmable Search', mediaOnly: true, needs: ['cx'],
    baseUrl: 'https://www.googleapis.com/customsearch/v1', keyEnv: 'GOOGLE_PSE_API_KEY', cxEnv: 'GOOGLE_PSE_CX', signup: 'https://programmablesearchengine.google.com/',
    note: '100 requêtes gratuites par jour. Renseignez la clé ET l’identifiant de moteur (cx).', speed: 'medium', priority: 18, models: [],
    search: { kind: 'google-pse' },
  },
  {
    id: 'exa', alias: 'ex', name: 'Exa (recherche sémantique, payant)', ...paid, mediaOnly: true,
    baseUrl: 'https://api.exa.ai', keyEnv: 'EXA_API_KEY', signup: 'https://dashboard.exa.ai/api-keys',
    note: 'Recherche neuronale + contenu des pages ; crédit d’essai à l’inscription.', speed: 'medium', priority: 20, models: [],
    search: { kind: 'exa' }, fetch: { kind: 'exa' },
  },
  {
    id: 'firecrawl', alias: 'fc', name: 'Firecrawl (page → markdown)', mediaOnly: true,
    baseUrl: 'https://api.firecrawl.dev/v1', keyEnv: 'FIRECRAWL_API_KEY', signup: 'https://www.firecrawl.dev/app/api-keys',
    note: 'Extraction de pages (JS inclus) ; crédits gratuits à l’inscription.', speed: 'medium', priority: 22, models: [],
    fetch: { kind: 'firecrawl' },
  },
  // ── Fournisseurs d'IMAGE / VIDÉO uniquement (pas de chat) ──
  {
    id: 'stability', alias: 'sa', name: 'Stability AI (images, payant)', ...paid, mediaOnly: true,
    baseUrl: 'https://api.stability.ai', keyEnv: 'STABILITY_API_KEY', signup: 'https://platform.stability.ai/account/keys',
    note: 'Images : Stable Image Core / Ultra / SD3.5.', speed: 'medium', priority: 60, models: [],
    image: { kind: 'stability', model: 'core' },
  },
  {
    id: 'fal', alias: 'fa', name: 'fal.ai (images & vidéo, payant)', ...paid, mediaOnly: true,
    baseUrl: 'https://queue.fal.run', keyEnv: 'FAL_KEY', signup: 'https://fal.ai/dashboard/keys',
    note: 'Images (FLUX…) et vidéo en file d’attente ; crédit offert à l’inscription.', speed: 'medium', priority: 58, models: [],
    image: { kind: 'fal', model: 'fal-ai/flux/schnell' }, video: { kind: 'fal', model: 'fal-ai/ltx-video' },
  },
  {
    id: 'bfl', alias: 'bf', name: 'Black Forest Labs (images FLUX, payant)', ...paid, mediaOnly: true,
    baseUrl: 'https://api.bfl.ai/v1', keyEnv: 'BFL_API_KEY', signup: 'https://dashboard.bfl.ai/', note: 'FLUX officiel.',
    speed: 'medium', priority: 58, models: [], image: { kind: 'bfl', model: 'flux-dev' },
  },
  {
    id: 'sdwebui', alias: 'sd', name: 'Stable Diffusion WebUI (local, AUTOMATIC1111)', mediaOnly: true, custom: true, local: true, optionalKey: true,
    baseUrl: '', signup: 'https://github.com/AUTOMATIC1111/stable-diffusion-webui',
    note: 'Votre propre GPU : renseignez l’URL (ex. http://127.0.0.1:7860), lancé avec --api. 100 % gratuit.',
    speed: 'local', priority: 5, models: [], image: { kind: 'sdwebui', model: '' },
  },
];

/** Capacités d'image ajoutées à des fournisseurs existants (par id). */
export const IMAGE_CAPS = {
  pollinations: { kind: 'pollinations', model: 'flux' },
  together: { kind: 'openai', model: 'black-forest-labs/FLUX.1-schnell-Free' },
  openai: { kind: 'openai', model: 'gpt-image-1' },
  xai: { kind: 'openai', model: 'grok-2-image' },
  gemini: { kind: 'gemini', model: 'gemini-2.5-flash-image' },
  huggingface: { kind: 'huggingface', model: 'black-forest-labs/FLUX.1-schnell' },
  cloudflare: { kind: 'cloudflare', model: '@cf/black-forest-labs/flux-1-schnell' },
  custom: { kind: 'openai', model: '' },
};

/** Audio ajouté à des fournisseurs existants (transcription Gemini via generateContent). */
export const AUDIO_CAPS = {
  gemini: { stt: 'gemini-2.5-flash', sttKind: 'gemini' },
};

/** Vidéo : xAI (même forme que /videos/generations) et endpoint personnalisé en passe-plat. */
export const VIDEO_CAPS = {
  xai: { kind: 'passthrough', model: 'grok-imagine-video' },
  custom: { kind: 'passthrough', model: '' },
};
