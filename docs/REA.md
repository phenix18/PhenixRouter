# Modèle REA de PhenixRouter

> Copyright © 2026 Fido-labs —kcw—

PhenixRouter modélise chaque appel IA comme un **échange économique** selon le cadre REA
(Resource – Event – Agent, McCarthy 1982) avec **dualité** : tout flux sortant a un flux entrant.

## Entités

| Entité | Valeurs | Rôle |
|---|---|---|
| **Agent** | `client:<nom>` (outil/clé API), `provider:<id>` (Groq, Gemini…), `system:cache` | Qui donne / reçoit |
| **Resource** | `request_quota` (1 requête consommée chez le fournisseur), `prompt_tokens`, `completion_tokens`, `cost_usd` (paiement estimé, fournisseurs payants uniquement) | Ce qui est échangé |
| **Event** | `REQUEST` (sortant : client → fournisseur), `COMPLETION` (entrant : fournisseur → client) | Ce qui s'est passé |

## Dualité

```
 client:claude-code ──REQUEST(request_quota=1, prompt_tokens=N)──▶ provider:groq
 client:claude-code ◀──COMPLETION(completion_tokens=M)─────────── provider:groq
                         └────────── même dualityId ──────────┘
```

Règles (vérifiées par `checkDuality`, exposé via `GET /api/ledger/verify` et le bouton « Vérifier la dualité REA ») :

1. Chaque `REQUEST` a exactement un `COMPLETION` de même `dualityId`, et réciproquement.
2. Pour un fournisseur **payant**, le `REQUEST` porte aussi `cost_usd` : la contrepartie monétaire de la dualité (client paie → fournisseur livre). Gratuit = aucune ressource `cost_usd`. Les agrégats (`costUsd`) alimentent le tableau de bord, les budgets et `phenixrouter usage`.
3. Un échec fournisseur produit un `COMPLETION` de quantité **0** (la dualité reste fermée, l'erreur est dans `meta`).
4. Un hit de cache utilise l'agent `system:cache` et consomme **0** quota.
5. Le grand livre est **append-only** (JSONL) ; les agrégats en mémoire sont reconstruits au démarrage.

## Schéma

```sql
CREATE TABLE agent    (id TEXT PRIMARY KEY, kind TEXT CHECK (kind IN ('client','provider','system')));
CREATE TABLE resource (type TEXT PRIMARY KEY);  -- request_quota | prompt_tokens | completion_tokens
CREATE TABLE event (
  id TEXT PRIMARY KEY, duality_id TEXT NOT NULL, type TEXT CHECK (type IN ('REQUEST','COMPLETION')),
  from_agent TEXT REFERENCES agent(id), to_agent TEXT REFERENCES agent(id), ts INTEGER NOT NULL, meta JSON
);
CREATE TABLE event_resource (event_id TEXT REFERENCES event(id), resource TEXT REFERENCES resource(type), qty REAL NOT NULL);
```

```ts
interface LedgerEvent {
  id: string; dualityId: string; type: 'REQUEST' | 'COMPLETION'; ts: number;
  from: string; to: string;
  resources: { type: 'request_quota' | 'prompt_tokens' | 'completion_tokens' | 'cost_usd'; qty: number }[];
  meta: { model?: string; route?: string; connection?: string; ms?: number; status?: 'ok' | 'error'; cached?: boolean; stream?: boolean; error?: string };
}
```

Implémentation : `src/rea/model.js` (types, `exchangeEvents`, `checkDuality`) et `src/rea/ledger.js` (persistance, agrégats, quotas journaliers par connexion).
