# 🔥 PhenixRouter

**Une seule API (OpenAI *et* Anthropic) vers des dizaines de modèles IA gratuits, avec basculement automatique.**
Sans dépendance, sans API payante, avec tableau de bord intégré.

> Copyright © 2026 Fido-labs —kcw— · Licence MIT · Inspiré du concept de FlagshipRouter / 9router (voir [NOTICE](NOTICE)) — réécriture complète, aucun code copié.

## Pourquoi PhenixRouter ?

- **Gratuit d'abord** : Groq, Cerebras, OpenRouter (`:free`), Gemini, Mistral, NVIDIA, GitHub Models, Cloudflare, Hugging Face, SambaNova, Together, Cohere, Zhipu, SiliconFlow, Ollama/LM Studio locaux, et **Pollinations sans clé** pour démarrer immédiatement.
- **Dynamique** : catalogue de modèles découvert **en direct** chez chaque fournisseur, modèles virtuels `phenix/auto|fast|smart|code|vision|reasoning|embed`, combos personnalisés (repli, rotation, plus rapide, aléatoire), alias.
- **Robuste** : rotation de clés, disjoncteur par connexion (`Retry-After` respecté), détection des erreurs cachées dans un 200, flux vides, cache de réponses, limites de débit.
- **Compatible** : `/v1/chat/completions`, `/v1/messages` (Claude Code), `/v1/responses` (Codex), `/v1/models`, `/v1/embeddings`, `/v1/images/generations`, `/v1/search`, `/v1/web/fetch`.
- **Traçable (REA)** : chaque échange est enregistré comme une paire *REQUEST/COMPLETION* dans un grand livre append-only ([docs/REA.md](docs/REA.md)).
- **Sûr** : clés chiffrées (AES‑256‑GCM), écoute locale par défaut, CSP stricte, garde SSRF.

## Démarrage rapide

```bash
git clone <ce dépôt> && cd PhenixRouter
node bin/phenixrouter.js start        # ou : npm start
```

Au premier lancement, le terminal affiche **une seule fois** le mot de passe du tableau de bord et une clé API `phx-…`.
Ouvrez <http://127.0.0.1:20128>, ajoutez vos clés gratuites dans **Fournisseurs** (ou via variables d'environnement, voir `.env.example`).

### Docker

```bash
cp .env.example .env   # optionnel
docker compose up -d
```

## Brancher vos outils

```bash
# Claude Code
export ANTHROPIC_BASE_URL="http://127.0.0.1:20128"
export ANTHROPIC_AUTH_TOKEN="phx-…"
export ANTHROPIC_MODEL="phenix/auto"
claude

# Codex / tout client OpenAI
export OPENAI_BASE_URL="http://127.0.0.1:20128/v1"
export OPENAI_API_KEY="phx-…"
```

Modèles : `phenix/auto` (meilleure chaîne disponible), `phenix/code`, `groq/llama-3.3-70b-versatile`, `gq/…`, vos combos `phenix/<nom>`, etc.

## CLI

```
phenixrouter start [--port N] [--host ADDR] [--data-dir DIR] [--no-browser]
phenixrouter keys list|create <nom>|revoke <id>
phenixrouter providers
phenixrouter reset-password
```

## Développement

```bash
npm test      # 44 tests, node:test, aucun réseau requis (faux fournisseur)
```

Documentation : [Architecture](docs/ARCHITECTURE.md) · [Modèle REA](docs/REA.md) · [Fournisseurs](docs/PROVIDERS.md).

## Bon à savoir

- Les offres gratuites ont leurs propres limites et conditions : elles peuvent changer sans préavis.
- Pollinations est expérimental. La recherche web par défaut (DuckDuckGo instantané + Wikipédia) est limitée : pour mieux, indiquez une instance **SearXNG** dans les réglages.
- Par défaut le serveur n'écoute que sur `127.0.0.1`. Si vous l'exposez, placez-le derrière un proxy TLS.

---
© 2026 Fido-labs —kcw—
