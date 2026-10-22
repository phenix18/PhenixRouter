# Architecture

> Copyright © 2026 Fido-labs —kcw—

```
Outils (Claude Code, Codex, Cursor…)           Tableau de bord (SPA, session cookie)
        │  /v1/chat/completions | /v1/messages | /v1/responses        │ /api/*
        ▼                                                              ▼
   src/api/v1.js  ──auth clé API/limites──▶  src/gateway.js ◀── src/api/admin.js
        │                                         │
        ▼                                         ▼
  core/translate (Anthropic/Responses ⇄ OpenAI)   REA ledger (src/rea) · store chiffré (src/store.js)
        │
        ▼
  core/router.js  résout `phenix/auto`, combos, alias, `provider/modèle`
        │   (catalogue dynamique : core/catalog.js ← providers/discovery.js)
        ▼
  core/chat.js  boucle de repli : clé suivante → modèle suivant
        │   health.js (disjoncteur, EWMA, Retry-After) · cache.js · ratelimit.js
        ▼
  core/dispatch.js  appel amont (stream « peek » du 1er chunk avant d'engager la réponse)
```

## Points clés
- **Zéro dépendance** : Node ≥ 20.9, `node:test`, tableau de bord en JS natif (aucun `innerHTML`, CSP stricte).
- **Catalogue dynamique** : les modèles sont découverts en direct (`/models` de chaque fournisseur), filtrés sur le gratuit (OpenRouter/Together : prix 0), avec liste de repli statique.
- **Basculement** : 429/5xx/401, réponse 200 contenant une erreur, flux vide, fonctionnalité non supportée (outils/vision), modèle introuvable → on tente la clé/le modèle suivant ; pause exponentielle par connexion.
- **Sécurité** : clés fournisseurs chiffrées AES‑256‑GCM, mot de passe scrypt, cookie HttpOnly/SameSite=Strict, contrôle d'Origin sur les écritures, écoute locale par défaut, garde SSRF sur `/v1/web/fetch`.
- **Volontairement absent** : interception MITM et import de jetons d'applications tierces.

## Gratuit / payant
Chaque fournisseur a un `tier` (`free` | `paid`). `Gateway.costBlock()` applique le **mode de coût** (`freeOnly` / `freeFirst` / `any`) et les budgets (jour/mois UTC, calculés depuis le grand livre) ; `callUpstream` saute les cibles bloquées et renvoie `403 cost_policy` si toutes le sont. `phenix/auto` classe le gratuit avant le payant (sauf mode `any`), `phenix/free` n'utilise jamais de payant, `phenix/best` classe par qualité seule. Priorité par connexion (1 = d'abord, rotation au sein d'un même niveau).

## Autres modules
- `core/tokensaver.js` — compresse les gros résultats d'outils et vieux messages (jamais le système ni le dernier message utilisateur).
- `core/audio.js` — `/v1/audio/transcriptions|translations|speech` (multipart réécrit sans toucher au binaire).
- `core/legacy.js` — import d'un `config.json` « phenixRouter v3 ».
- `assets.js` — lecture des fichiers depuis le disque **ou** depuis l'exécutable autonome (Node SEA, `scripts/build-exe.mjs`).

## Tests
`npm test` : 60 tests (REA, traductions, routage, e2e avec faux fournisseur : basculement, flux, cache, sécurité).
