# Changelog

Copyright © 2026 Fido-labs —kcw—

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
