# Changelog

Copyright © 2026 Fido-labs —kcw—

## 1.5.1 — Identifiants et mise en route fiables
- **Identifiants conservés** : copie du mot de passe et de la clé `default` dans `credentials.txt` (0600) ; chaque démarrage indique où les retrouver ou comment les réinitialiser.
- **Base URL toujours affichées** (OpenAI `/v1` et Claude Code sans `/v1`, adresses du réseau local avec `--host 0.0.0.0`).
- Nouvelles commandes : `phenixrouter info`, `connect <fournisseur> <clé>`, `test` (requête réelle + diagnostic détaillé).
- Message d'erreur explicite quand aucune clé fournisseur n'est configurée (Pollinations seul n'est qu'un secours).
- 116 tests.

## 1.5.0 — Vente de tokens (module optionnel)
- **Boutique de tokens prépayés** (désactivée par défaut, supprimable : réglage « Activé » ou suppression de `src/shop` + `public/shop`) : 1 M de tokens = 3 USD, packs et montant libre, multiplicateurs par modèle.
- **Page web `/shop`** (mobile + PC, FR/EN, installable) : commande, paiement manuel ou **Binance Pay** (API marchande, statut revérifié par appel signé, jamais sur la foi du webhook), remise de la licence `phx-…`, recharge, compte (solde, usage, derniers appels) et exemples d'intégration PC/mobile.
- **Licences = clés API prépayées** : débit automatique à chaque appel réussi non mis en cache, `402 insufficient_credits` à zéro, routage limité aux connexions marquées « revente ».
- **Vue admin « Ventes »** : réglages, commandes (confirmation manuelle), licences, remise hors ligne (Mobile Money, cadeau), encaissé / vendu / consommé / coût fournisseurs / marge.
- **REA** : livre `sales.jsonl` chaîné par hachage ; dualité PAYMENT_RECEIVED ↔ CREDIT_GRANTED vérifiée (voir `docs/VENTE-TOKENS.md`).
- Garde-fous : limites de débit par IP réelle (tunnel), administration refusée via Internet tant que la boutique est active, secrets Binance scellés (AES‑256‑GCM), clé en clair effacée après 24 h.
- Nouveau logo (phénix) ; 114 tests (12 nouveaux).

## 1.4.0 — Équipe et sécurité d'exploitation
- **Quotas par clé cliente** : requêtes/jour, budget/jour et /mois (USD), modèles autorisés (`groq/*`, `phenix/free`…), date d'expiration ; appliqués sur chat, Anthropic, Responses, Gemini, MCP, embeddings et images ; refus `429 quota_exceeded` / `403 model_not_allowed`. Noms de clés uniques.
- **Journal d'audit chaîné par hachage** (`audit.jsonl`) : chaque action d'administration (sans valeur sensible) et chaque échec de connexion ; altération ou suppression détectée (`GET /api/audit`, vue « Journal »).
- **Sauvegarde chiffrée** (scrypt + AES‑256‑GCM) portable d'une machine à l'autre : `phenixrouter backup|restore`, bouton dans Réglages ; copie de sécurité avant restauration.
- **Alertes de budget** à 80 % et 100 % (une fois chacune) + **webhook** facultatif (Slack, Discord, ntfy…) également utilisé pour les clés en panne ; bandeau sur la vue d'ensemble.
- **Proxys SOCKS5** (`socks5://`, `socks5h://` avec authentification) ; le tunnel est fermé avec la requête.
- **Cache sémantique** (facultatif, sans API) : réutilise la réponse d'une question quasi identique (même contexte, mêmes nombres, même polarité, température 0, sans outils).
- 102 tests (16 nouveaux).

## 1.3.0 — Exploitation : sonde, service, diagnostic
- **Sonde de santé des clés** (réglage `probeIntervalMin`, 30 min par défaut, 0 = off) : vérifie en arrière-plan les clés via la découverte de modèles (aucun appel de génération, donc aucun coût) ; clé révoquée → mise en pause + alerte au journal ; clé rétablie → réactivée. Bouton « Vérifier maintenant » et état par connexion dans « Fournisseurs » (`GET /api/probe`, `POST /api/probe/run`).
- **Service permanent sans droits admin** : `phenixrouter service install|uninstall|status` (systemd utilisateur, launchd, tâche planifiée Windows).
- **Diagnostic** : `phenixrouter doctor` (Node, dossier de données, port, clés, tunnels, réseau).
- **Mise en route** : carte d'étapes détectées automatiquement sur la vue d'ensemble.
- Le test de connexion est factorisé dans `core/probe.js` ; les erreurs de découverte conservent le code HTTP.
- 86 tests (10 nouveaux).

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
