// Copyright (c) 2026 Fido-labs —kcw—
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exchangeEvents, checkDuality, EventType } from '../src/rea/model.js';
import { Ledger } from '../src/rea/ledger.js';

test('un échange produit exactement REQUEST + COMPLETION liés par dualityId', () => {
  const [req, comp] = exchangeEvents({ client: 'k1', provider: 'groq', model: 'groq/x', tokensIn: 10, tokensOut: 4, ms: 120, status: 'ok' });
  assert.equal(req.type, EventType.REQUEST);
  assert.equal(comp.type, EventType.COMPLETION);
  assert.equal(req.dualityId, comp.dualityId);
  assert.equal(req.from, 'client:k1');
  assert.equal(req.to, 'provider:groq');
  assert.equal(comp.from, 'provider:groq');
  assert.equal(comp.resources[0].qty, 4);
  assert.equal(req.resources.find((r) => r.type === 'request_quota').qty, 1);
  assert.ok(checkDuality([req, comp]).ok);
});

test('un échec garde la dualité (COMPLETION de quantité 0)', () => {
  const evs = exchangeEvents({ client: 'k1', provider: 'groq', status: 'error', error: 'boom', tokensIn: 7, tokensOut: 99, ms: 5 });
  assert.equal(evs[1].resources[0].qty, 0);
  assert.equal(evs[0].meta.status, 'error');
  assert.ok(checkDuality(evs).ok);
});

test('une réponse en cache consomme 0 quota fournisseur (agent système « cache »)', () => {
  const [req] = exchangeEvents({ client: 'k1', provider: 'groq', cached: true, status: 'ok', tokensIn: 5, tokensOut: 5 });
  assert.equal(req.to, 'system:cache');
  assert.equal(req.resources.find((r) => r.type === 'request_quota').qty, 0);
});

test('checkDuality détecte une REQUEST orpheline', () => {
  const [req] = exchangeEvents({ client: 'a', provider: 'p', status: 'ok' });
  const r = checkDuality([req]);
  assert.equal(r.ok, false);
  assert.equal(r.orphans.length, 1);
});

test('le grand livre agrège, persiste et se recharge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-ledger-'));
  try {
    const l = new Ledger(dir);
    l.recordExchange({ client: 'a', provider: 'groq', model: 'groq/m', connection: 'c1', tokensIn: 10, tokensOut: 5, ms: 100, status: 'ok' });
    l.recordExchange({ client: 'a', provider: 'groq', model: 'groq/m', connection: 'c1', tokensIn: 20, tokensOut: 6, ms: 300, status: 'ok' });
    l.recordExchange({ client: 'b', provider: 'cerebras', model: 'cerebras/n', status: 'error', error: 'x', tokensIn: 3, ms: 10 });
    const s = l.summary();
    assert.equal(s.total.requests, 3);
    assert.equal(s.total.ok, 2);
    assert.equal(s.total.errors, 1);
    assert.equal(s.total.tokensIn, 33);
    assert.equal(s.total.tokensOut, 11);
    assert.equal(s.byProvider.groq.requests, 2);
    assert.equal(s.byClient.b.errors, 1);
    assert.equal(l.dailyCount('c1'), 2);
    assert.ok(l.verifyDuality().ok);
    await new Promise((r) => setTimeout(r, 100)); // laisse l'écriture asynchrone se terminer
    const reloaded = new Ledger(dir);
    assert.equal(reloaded.summary().total.requests, 3);
    assert.equal(reloaded.dailyCount('c1'), 2);
    assert.ok(reloaded.verifyDuality().ok);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
