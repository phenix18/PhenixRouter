# Contribuer

Copyright © 2026 Fido-labs —kcw—

- Node.js ≥ 20.9, **aucune dépendance** d'exécution : n'en ajoutez pas sans discussion.
- `npm test` doit rester vert (tests `node:test`, sans réseau : utilisez le faux fournisseur de `tests/helpers.js`).
- Ajouter un fournisseur compatible OpenAI = une entrée dans `src/providers/registry.js` (ou `extra.js`) + sa variable dans `.env.example` + une ligne dans `docs/PROVIDERS.md`.
- Tableau de bord : JS natif, jamais d'`innerHTML` (CSP stricte) ; textes dans `public/js/i18n.js` (fr + en).
- Messages de commit en français ou en anglais, au présent, une idée par commit.
