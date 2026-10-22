# Changelog

Copyright © 2026 Fido-labs —kcw—

## 1.2.0 — Parité FlagshipRouter (contrat d'API compatible)
- **Proxys sortants** : pool, proxy dédié par connexion, rotation, test ; tunnel HTTP CONNECT sans dépendance ; **échec fermé** (jamais de sortie directe si le proxy demandé est indisponible) ; identifiants masqués.
- **Images multi-fournisseurs** (Pollinations, compatibles OpenAI, Stability, fal.ai, BFL/FLUX) ; **vidéo asynchrone** `/v1/videos/generations` + suivi, identifiants **signés HMAC** (pas de SSRF).
- **Recherche web** (Tavily, Brave, Serper, Linkup, Google PSE, Exa, repli gratuit) et **lecture de page** (Tavily, Firecrawl, repli) normalisées, avec basculement.
- **Audio étendu** : Deepgram (STT), ElevenLabs (TTS), `/v1/audio/voices`, multipart.
- **Catalogues par type** `/v1/models/<type>`, `/v1/models/info`, `/api/health`.
- **Gemini natif** `/v1beta` (generateContent, streamGenerateContent, embedContent, countTokens).
- **MCP** (HTTP streamable) sur `/mcp` : `phenix_chat|search|fetch|image|models|usage`.
- **Config des outils clients** (écriture non destructive + sauvegarde `.bak`, clé API dédiée par outil) ; **tunnel** cloudflared / tailscale (binaires externes).
- **~25 fournisseurs** supplémentaires ; nouvelle vue « Accès & proxys » ; CLI `setup` étendu.
- Non repris volontairement : OAuth d'abonnements, MITM, System One, icône de barre, synchro cloud, TTS non officiels, SOCKS.
- 76 tests (dont 16 de parité) ; correctifs : tunnel HTTPS via proxy (agent ignorait la connexion sécurisée).

## 1.1.0 — Tout-en-un (gratuit **et** payant)
- **Fournisseurs payants** (OpenAI, Anthropic, DeepSeek, xAI, Perplexity, Fireworks, DeepInfra, Hyperbolic, Novita, Moonshot, Qwen) à côté des gratuits ; `phenix/free` et `phenix/best` ; alias hérités `phenixRouter-free`.
- **Mode de coût** (gratuit seul / gratuit d'abord / tout), **budgets** quotidien et mensuel, **coût estimé** dans le grand livre REA (`cost_usd`), tableau de bord et `phenixrouter usage`.
- **Priorité par connexion** (+ rotation au sein d'un niveau).
- **Token Saver**, **audio** (`/v1/audio/*`), `/health`.
- **CLI** : `list`, `models`, `status`, `usage`, `import`, `setup claude|codex|openai`.
- **Import** d'un `config.json` « phenixRouter v3 » (CLI + tableau de bord).
- **Exécutable autonome** (`npm run build:exe`, Windows/Linux/macOS), installeurs, workflow de release GitHub.

## 1.0.0
- Première version : passerelle OpenAI/Anthropic/Responses, catalogue dynamique, basculement, cache, tableau de bord, grand livre REA.
