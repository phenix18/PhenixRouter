// Copyright (c) 2026 Fido-labs —kcw—
// Grand livre des ventes (REA) : append-only, chaîné par hachage. Dualité : PAYMENT_RECEIVED ↔ CREDIT_GRANTED.
import { AuditLog } from '../core/audit.js';

export class ShopLedger extends AuditLog {
  constructor(dir) { super(dir, 'sales.jsonl'); }

  /** Événement économique : { type, orderId, ... } stocké dans `data`. */
  event(type, data, actor = 'système') {
    return this.record({ actor, action: type, data: { type, ...data } });
  }

  /** Chaque encaissement doit avoir exactement une sortie de crédit équivalente, et inversement. */
  verifyDuality() {
    const byOrder = new Map();
    for (const e of this.all()) {
      const d = e.data;
      if (!d?.orderId) continue;
      const o = byOrder.get(d.orderId) ?? { payments: [], grants: [] };
      if (d.type === 'PAYMENT_RECEIVED') o.payments.push(d);
      if (d.type === 'CREDIT_GRANTED') o.grants.push(d);
      byOrder.set(d.orderId, o);
    }
    const problems = [];
    for (const [id, o] of byOrder) {
      if (o.payments.length !== o.grants.length) problems.push({ orderId: id, reason: `${o.payments.length} paiement(s) pour ${o.grants.length} remise(s) de crédit` });
      else if (o.payments.length === 1 && o.payments[0].tokens !== o.grants[0].tokens) problems.push({ orderId: id, reason: 'tokens payés ≠ tokens remis' });
    }
    return { ok: problems.length === 0, orders: byOrder.size, problems };
  }

  /** Totaux : encaissé, tokens vendus. */
  totals() {
    let revenueUsd = 0; let tokensSold = 0; let payments = 0;
    for (const e of this.all()) {
      const d = e.data;
      if (d?.type === 'PAYMENT_RECEIVED') { revenueUsd += Number(d.amountUsd) || 0; payments += 1; }
      if (d?.type === 'CREDIT_GRANTED') tokensSold += Number(d.tokens) || 0;
    }
    return { revenueUsd: Math.round(revenueUsd * 100) / 100, tokensSold, payments };
  }
}
