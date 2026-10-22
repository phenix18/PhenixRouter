# Comparaison : FlagshipRouter · phenixRouter v3 (zip) · PhenixRouter 1.1

> Copyright © 2026 Fido-labs —kcw—. État réel du code, y compris ce qui **manque**.

Légende : ✅ présent · 🟡 partiel · ❌ absent · ⛔ volontairement non repris

| Fonction | FlagshipRouter | zip v3 (Python) | PhenixRouter 1.1 |
|---|---|---|---|
| API `/v1/chat/completions` (OpenAI) | ✅ | ✅ | ✅ |
| API Anthropic `/v1/messages` (Claude Code), outils + streaming | ✅ | ❌ | ✅ |
| API `/v1/responses` (Codex) | ✅ | ❌ | ✅ |
| `/v1/models` dynamique | ✅ | 🟡 liste locale + synchro | ✅ découverte en direct, tags, prix, `free` |
| Embeddings | ✅ | ❌ | ✅ |
| Images | ✅ multi-fournisseurs | ❌ | ✅ Pollinations (sans clé), compatibles OpenAI, Stability, fal.ai, BFL |
| Audio : transcription / TTS | ✅ | ❌ | ✅ Groq (gratuit), OpenAI (payant), endpoint perso |
| Vidéo asynchrone / System One | ✅ | ❌ | ✅ fal.ai, xAI, endpoint perso / ⛔ System One |
| Recherche web / lecture de page | ✅ | ❌ | ✅ Tavily, Brave, Serper, Linkup, Google PSE, Exa, Firecrawl + repli gratuit (SearXNG ; garde SSRF) |
| Fournisseurs gratuits à clé | ✅ | 🟡 5 | ✅ ~20 + Pollinations sans clé + Ollama/LM Studio |
| Fournisseurs payants à clé | ✅ | ❌ (gratuit uniquement) | ✅ 11 + endpoint personnalisé |
| Beaucoup d'autres fournisseurs (100+) | ✅ | ❌ | 🟡 ~55 ; ajouter un compatible OpenAI = 1 entrée dans `registry.js` |
| Fournisseurs par abonnement OAuth (Claude/Codex/Copilot/Kiro/Cursor…) | ✅ | ❌ | ⛔ réutilisation de jetons d'abonnements grand public : risque pour les comptes et contraire aux conditions des services |
| Interception MITM | ✅ | ❌ | ⛔ |
| Rotation de clés / priorité | ✅ | ✅ round-robin + priorité | ✅ + rotation par niveau de priorité |
| Basculement auto (429/5xx/401, 200+erreur, flux vide, outil non supporté) | ✅ | 🟡 429/401/5xx | ✅ |
| Coupe-circuit, `Retry-After`, pause exponentielle | ✅ | 🟡 cooldown fixe | ✅ |
| Combos (repli / rotation / plus rapide / aléatoire), alias | ✅ | ❌ | ✅ |
| Modèles virtuels `auto/fast/smart/code/vision/reasoning/embed/free/best` | 🟡 | 🟡 `auto` | ✅ |
| Cache de réponses | ✅ | ✅ annoncé | ✅ réellement implémenté (LRU, température 0) |
| Limite de débit | ✅ | ✅ annoncé | ✅ par clé API |
| Suivi d'usage / coûts / budgets | ✅ | 🟡 compteurs | ✅ grand livre REA, coût estimé, budgets jour/mois |
| Token Saver | ✅ (RTK, caveman, headroom…) | ❌ | 🟡 compression des gros résultats d'outils et vieux messages |
| Tableau de bord | ✅ Next.js | 🟡 page HTML, clé admin affichée en clair | ✅ SPA sans dépendance, session HttpOnly, CSP stricte, fr/en |
| CLI | ✅ + menu terminal + tray | ✅ `list/models/status` | ✅ `start/keys/list/models/status/usage/import/setup/providers` (sans tray) |
| Écriture de config des outils (Claude Code, Codex, Cline, OpenCode, Copilot…) | ✅ | ❌ | ✅ écriture non destructive + `.bak` ; Continue en extrait ; ⛔ Kilo |
| Proxy pools, tunnel (cloudflared/tailscale), Gemini natif `/v1beta`, MCP | ✅ | ❌ | ✅ (proxys HTTP/HTTPS, échec fermé ; tunnels via binaires externes) |
| Cloud sync, icône de barre, SOCKS, AssemblyAI, ComfyUI | ✅ | ❌ | ⛔ / ❌ non repris |
| Sécurité par défaut | mot de passe `123456` | clé admin publique, CORS `*` + credentials | mot de passe aléatoire, clés chiffrées AES‑256‑GCM, écoute locale |
| Exécutable autonome `.exe` / Linux / macOS | ❌ | ✅ PyInstaller (Windows) | ✅ Node SEA, 6 cibles, installeurs, release CI |
| Installeur Windows / service Linux / launchd | ❌ | ✅ (droits admin, `C:\`) | ✅ par utilisateur, sans admin |
| Import du `config.json` v3 | — | — | ✅ (clés à remplacer ignorées ; clé admin non reprise) |
| Docker | ✅ | ❌ | ✅ |
| Dépendances d'exécution | des centaines (Next.js…) | FastAPI, uvicorn, httpx, rich | **aucune** |
| Tests | partiels, échecs connus | aucun | 60 tests verts (faux fournisseur, aucun réseau) |

## Ce qui reste à faire si vous en avez besoin
Vidéo / System One, pools de proxys sortants, tunnel, synchronisation cloud, écriture automatique de config pour Cline/OpenCode/Copilot, icône de barre système, API Gemini native. Dites ce qui compte pour vous : ce sont des ajouts indépendants.
