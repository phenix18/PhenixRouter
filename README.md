# 🔥 PhenixRouter

**Une seule API (OpenAI *et* Anthropic) vers des dizaines de modèles IA — gratuits d'abord, payants si vous le voulez — avec basculement automatique.**
Tout-en-un, zéro dépendance, tableau de bord intégré, exécutable autonome.

> Copyright © 2026 Fido-labs —kcw— · Licence MIT · Concept inspiré de FlagshipRouter / 9router et du paquet « phenixRouter v3 » (voir [NOTICE](NOTICE)) — réécriture complète.

## Ce que ça fait

- **Gratuit d'abord** : Groq, Cerebras, OpenRouter (`:free`), Gemini, Mistral, NVIDIA, GitHub Models, Cloudflare, Hugging Face, SambaNova, Together, Cohere, Zhipu, SiliconFlow, Ollama/LM Studio, et **Pollinations sans clé** pour démarrer tout de suite.
- **Payant en option** : OpenAI, Anthropic, DeepSeek, xAI, Perplexity, Fireworks, DeepInfra, Hyperbolic, Novita, Moonshot, Qwen. **Mode de coût** *gratuit seul / gratuit d'abord / tout*, **budgets** quotidien et mensuel, coût estimé par requête.
- **Dynamique** : catalogue de modèles découvert **en direct**, modèles virtuels `phenix/auto|free|best|fast|smart|code|vision|reasoning|embed`, combos (repli, rotation, plus rapide, aléatoire), alias, priorité par clé.
- **Robuste** : rotation de clés, coupe-circuit (`Retry-After`), erreurs cachées dans un 200, flux vides, outils non supportés, cache de réponses, limites de débit.
- **Compatible** : `/v1/chat/completions`, `/v1/messages` (Claude Code), `/v1/responses` (Codex), `/v1/models`, `/v1/embeddings`, `/v1/images/generations`, `/v1/audio/transcriptions|translations|speech`, `/v1/videos/generations`, `/v1/search`, `/v1/web/fetch`, `/v1/models/<type>`, `/v1beta` (Gemini natif), `/mcp` (MCP), `/health`.
- **Réseau** : proxys sortants par connexion ou en pool (échec fermé), tunnel cloudflared/tailscale, config automatique des outils clients (`phenixrouter setup`).
- **Économe** : *Token Saver* (compresse les gros résultats d'outils), cache, budgets.
- **Traçable (REA)** : chaque échange = paire *REQUEST/COMPLETION* (+ `cost_usd` si payant) dans un grand livre append-only ([docs/REA.md](docs/REA.md)).
- **Sûr** : clés chiffrées (AES‑256‑GCM), mot de passe aléatoire, écoute locale par défaut, CSP stricte, garde SSRF.

Comparaison honnête avec FlagshipRouter et le paquet v3, y compris ce qui manque : [docs/COMPARAISON.md](docs/COMPARAISON.md).

## Démarrage rapide

**Option 1 — exécutable autonome (rien à installer)** : téléchargez le fichier de votre système dans *Releases* (ou construisez-le, voir plus bas) puis lancez-le.
- Windows : double-clic sur `install.bat` (installation par utilisateur, sans droits admin), ou lancez `phenixrouter-win-x64.exe start`.
- Linux / macOS : `sh install.sh` (service systemd/launchd facultatif), ou `./phenixrouter-linux-x64 start`.

**Option 2 — depuis les sources** (Node.js 20.9+) :

```bash
git clone <ce dépôt> && cd PhenixRouter
node bin/phenixrouter.js start        # ou : npm start · start.sh · start.bat
```

Au premier lancement, le terminal affiche **une seule fois** le mot de passe du tableau de bord et une clé API `phx-…`.
Ouvrez <http://127.0.0.1:20128>, ajoutez vos clés dans **Fournisseurs** (ou via variables d'environnement, voir `.env.example`).

**Option 3 — Docker** : `cp .env.example .env && docker compose up -d`

> Vous venez du paquet Python « phenixRouter v3 » ? `phenixrouter import config.json` (ou *Réglages → Importer*) reprend vos comptes (les clés « A_REMPLACER » sont ignorées, la clé admin par défaut n'est pas reprise).

## Gratuit, payant, budgets

| Mode (Réglages → *Mode de coût*) | Comportement |
|---|---|
| **Gratuit seul** | Aucun fournisseur payant n'est jamais appelé (`403 cost_policy` si on en demande un). |
| **Gratuit d'abord** *(défaut)* | `phenix/auto` essaie tous les gratuits avant le moindre payant. Un modèle payant demandé explicitement est autorisé. |
| **Tout** | Classement par qualité, payant inclus. |

`phenix/free` n'utilise jamais de payant · `phenix/best` classe par qualité seule · un budget quotidien/mensuel bloque les payants une fois atteint (le gratuit continue). Les prix sont **indicatifs** et modifiables ; seule la facture du fournisseur fait foi.

## Brancher vos outils

```bash
phenixrouter setup claude --key phx-… --write   # écrit ~/.claude/settings.json (sauvegarde .bak)
phenixrouter setup codex                        # affiche le bloc config.toml
phenixrouter setup openai                       # Cursor, Cline, Continue, OpenCode…
```

Ou à la main : `ANTHROPIC_BASE_URL=http://127.0.0.1:20128`, `ANTHROPIC_AUTH_TOKEN=phx-…`, `ANTHROPIC_MODEL=phenix/auto` (Claude Code) ; `OPENAI_BASE_URL=http://127.0.0.1:20128/v1`, `OPENAI_API_KEY=phx-…` (Codex et clients OpenAI).

## CLI

```
phenixrouter start [--port N] [--host ADDR] [--data-dir DIR] [--no-browser]
phenixrouter list | models [--all] | status | usage | providers
phenixrouter keys list|create <nom>|revoke <id>
phenixrouter import <config.json>        phenixrouter setup claude|codex|openai
phenixrouter reset-password
```

## Construire l'exécutable

```bash
npm run build:exe                 # pour cette machine → dist/phenixrouter-<os>-<arch>[.exe]
npm run build:exe:win             # cross-compilation Windows x64 (et :linux, :mac)
```

Principe : bundle JS unique (esbuild, à la demande via `npx`) + tableau de bord embarqué + injection dans une copie du binaire Node (SEA). L'application reste **sans dépendance d'exécution**. Le workflow `.github/workflows/release.yml` construit Windows, Linux (x64/arm64) et macOS (arm64/x64) sur un tag `vX.Y.Z` et publie une Release avec `SHA256SUMS.txt`.
Les exécutables ne sont pas signés : Windows SmartScreen / macOS Gatekeeper demanderont une confirmation au premier lancement.

## Développement

```bash
npm test      # 76 tests, node:test, aucun réseau requis (faux fournisseur)
```

Documentation : [Architecture](docs/ARCHITECTURE.md) · [Modèle REA](docs/REA.md) · [Fournisseurs](docs/PROVIDERS.md) · [Comparaison](docs/COMPARAISON.md) · [Changelog](CHANGELOG.md).

## Bon à savoir

- Les offres gratuites ont leurs propres limites et conditions, qui changent sans préavis.
- Pollinations est expérimental. La recherche web par défaut (DuckDuckGo instantané + Wikipédia) est limitée : indiquez une instance **SearXNG** dans les réglages pour mieux.
- Par défaut le serveur n'écoute que sur `127.0.0.1`. Si vous l'exposez, mettez-le derrière un proxy TLS.
- Non repris volontairement : les fournisseurs par jetons d'abonnement OAuth et l'interception MITM de FlagshipRouter.

---
© 2026 Fido-labs —kcw—
