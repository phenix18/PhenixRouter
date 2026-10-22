# Fournisseurs gratuits

> Copyright © 2026 Fido-labs —kcw—. Les offres gratuites changent : vérifiez les conditions de chaque service.

| Fournisseur | Préfixe | Variable d'environnement | Remarque |
|---|---|---|---|
| Groq | `gq` | `GROQ_API_KEY` | très rapide, limites par minute/jour |
| Cerebras | `cb` | `CEREBRAS_API_KEY` | inférence ultra-rapide |
| OpenRouter | `or` | `OPENROUTER_API_KEY` | uniquement les modèles `:free` (prix 0) |
| Google Gemini | `gm` | `GEMINI_API_KEY` | vision, long contexte |
| Mistral | `mi` | `MISTRAL_API_KEY` | palier « Experiment » |
| NVIDIA NIM | `nv` | `NVIDIA_API_KEY` | crédits d'essai |
| GitHub Models | `gh` | `GITHUB_MODELS_TOKEN` | jeton GitHub |
| Cloudflare Workers AI | `cf` | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | quota quotidien |
| Hugging Face | `hf` | `HF_TOKEN` | |
| SambaNova | `sn` | `SAMBANOVA_API_KEY` | |
| Together | `tg` | `TOGETHER_API_KEY` | modèles gratuits uniquement |
| Cohere | `co` | `COHERE_API_KEY` | clé d'essai |
| Zhipu | `zp` | `ZHIPU_API_KEY` | |
| SiliconFlow | `sf` | `SILICONFLOW_API_KEY` | |
| Pollinations | `pl` | — | **sans clé**, expérimental |
| Ollama / LM Studio | `ol` / `lm` | — | local, détectés automatiquement |
| Personnalisé | `cu` | — | tout endpoint compatible OpenAI |

## Fournisseurs payants (facultatifs)

Désactivés tant qu'aucune clé n'est ajoutée. Le **mode de coût** (Réglages) décide de leur usage : *gratuit seul*, *gratuit d'abord* (défaut) ou *tout*. Des budgets quotidien/mensuel (USD) bloquent les fournisseurs payants une fois atteints ; le gratuit reste disponible.

| Fournisseur | Préfixe | Variable | Remarque |
|---|---|---|---|
| OpenAI | `oa` | `OPENAI_API_KEY` | GPT, o-series, embeddings, Whisper/TTS |
| Anthropic | `an` | `ANTHROPIC_API_KEY` | Claude via la couche de compatibilité OpenAI |
| DeepSeek | `ds` | `DEEPSEEK_API_KEY` | très bon marché |
| xAI | `xa` | `XAI_API_KEY` | Grok |
| Perplexity | `px` | `PERPLEXITY_API_KEY` | Sonar, recherche web intégrée (sans outils) |
| Fireworks | `fw` | `FIREWORKS_API_KEY` | |
| DeepInfra | `di` | `DEEPINFRA_API_KEY` | |
| Hyperbolic | `hy` | `HYPERBOLIC_API_KEY` | |
| Novita | `nt` | `NOVITA_API_KEY` | |
| Moonshot (Kimi) | `ms` | `MOONSHOT_API_KEY` | |
| Alibaba Qwen (DashScope) | `qw` | `DASHSCOPE_API_KEY` | |

Les prix affichés sont **indicatifs** (USD / million de tokens) et modifiables dans les réglages (`pricing`) ; le coût du grand livre est une estimation, seule la facture du fournisseur fait foi. L'audio (Whisper/TTS) n'est pas chiffré.

Plusieurs clés par fournisseur : séparez-les par des virgules dans la variable, ou ajoutez-les dans le tableau de bord — la rotation est automatique.
