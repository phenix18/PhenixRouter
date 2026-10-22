// Copyright (c) 2026 Fido-labs —kcw—
// Modèle REA (Resource–Event–Agent) de PhenixRouter.
//
//   [Client] --(REQUEST: quota + prompt tokens)--> [Fournisseur]
//       ^                                              |
//       +-------(COMPLETION: completion tokens)--------+     (dualité économique)
//
// Chaque échange crée exactement deux événements liés par `dualityId` :
//  - REQUEST     (outflow)  : le client consomme du quota fournisseur, envoie des tokens et, pour un
//                             fournisseur payant, engage un coût estimé (resource cost_usd) ;
//  - COMPLETION  (inflow)   : le fournisseur livre des tokens générés.
// Un échec produit tout de même une COMPLETION de quantité 0 (statut "error") afin que la
// dualité reste vérifiable : il n'existe jamais de REQUEST orpheline.
import { randomUUID } from 'node:crypto';

const AgentKind = Object.freeze({ CLIENT: 'client', PROVIDER: 'provider', SYSTEM: 'system' });
export const ResourceType = Object.freeze({
  REQUEST_QUOTA: 'request_quota',
  PROMPT_TOKENS: 'prompt_tokens',
  COMPLETION_TOKENS: 'completion_tokens',
  COST_USD: 'cost_usd', // paiement estimé (fournisseurs payants) : contrepartie monétaire de la dualité
});
export const EventType = Object.freeze({ REQUEST: 'REQUEST', COMPLETION: 'COMPLETION' });
const Direction = Object.freeze({ OUTFLOW: 'outflow', INFLOW: 'inflow' });

const agentId = (kind, name) => `${kind}:${name}`;

/**
 * Construit la paire d'événements d'un échange.
 * @param {object} x
 */
export function exchangeEvents(x) {
  const ts = x.ts ?? Date.now();
  const dualityId = x.dualityId ?? randomUUID();
  const client = agentId(AgentKind.CLIENT, x.client ?? 'anonymous');
  const provider = agentId(x.cached ? AgentKind.SYSTEM : AgentKind.PROVIDER, x.cached ? 'cache' : x.provider ?? 'unknown');
  const ok = x.status === 'ok';
  const tokensIn = Math.max(0, Math.round(x.tokensIn ?? 0));
  const tokensOut = ok ? Math.max(0, Math.round(x.tokensOut ?? 0)) : 0;
  const meta = {
    route: x.route ?? 'chat',
    model: x.model ?? null,
    connection: x.connection ?? null,
    status: ok ? 'ok' : 'error',
    ms: Math.round(x.ms ?? 0),
    cached: !!x.cached,
    stream: !!x.stream,
    error: ok ? undefined : String(x.error ?? 'unknown').slice(0, 300),
  };
  return [
    {
      id: randomUUID(), ts, type: EventType.REQUEST, direction: Direction.OUTFLOW, dualityId,
      from: client, to: provider,
      resources: [
        { type: ResourceType.REQUEST_QUOTA, qty: x.cached ? 0 : 1 },
        { type: ResourceType.PROMPT_TOKENS, qty: tokensIn },
        ...(x.costUsd > 0 ? [{ type: ResourceType.COST_USD, qty: Math.round(x.costUsd * 1e8) / 1e8 }] : []),
      ],
      meta,
    },
    {
      id: randomUUID(), ts: ts + meta.ms, type: EventType.COMPLETION, direction: Direction.INFLOW, dualityId,
      from: provider, to: client,
      resources: [{ type: ResourceType.COMPLETION_TOKENS, qty: tokensOut }],
      meta: { status: meta.status },
    },
  ];
}

/** Vérifie l'invariant de dualité : un REQUEST ⇔ une COMPLETION. */
export function checkDuality(events) {
  const seen = new Map();
  for (const e of events) {
    const s = seen.get(e.dualityId) ?? { req: 0, comp: 0 };
    if (e.type === EventType.REQUEST) s.req += 1;
    else if (e.type === EventType.COMPLETION) s.comp += 1;
    seen.set(e.dualityId, s);
  }
  const orphans = [];
  for (const [id, s] of seen) if (s.req !== 1 || s.comp !== 1) orphans.push({ dualityId: id, ...s });
  return { ok: orphans.length === 0, exchanges: seen.size, orphans };
}
