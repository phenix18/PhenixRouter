// Copyright (c) 2026 Fido-labs —kcw—
// Tests : fournisseurs payants, mode de coût, budgets, priorités, Token Saver, audio, import legacy.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMockUpstream, createRouter } from './helpers.js';
import { priceOf, estimateCost } from '../src/providers/pricing.js';
import { saveTokens, squeeze, tidy } from '../src/core/tokensaver.js';
import { multipartModel, setMultipartModel } from '../src/core/audio.js';
import { importLegacyConfig } from '../src/core/legacy.js';

let up;
let r;
const PRICING = { 'openai/openai-model-a': { in: 10, out: 20 } };
const chat = (model, extra = {}) => r.api('/v1/chat/completions', { method: 'POST', body: { model, messages: [{ role: 'user', content: 'Salut' }], ...extra } });

before(async () => {
  up = await createMockUpstream();
  r = await createRouter();
  r.gw.addConnection({ provider: 'groq', name: 'groq-1', apiKey: 'gsk_secret_one', baseUrl: up.url('groq') });
  r.gw.addConnection({ provider: 'openai', name: 'openai-1', apiKey: 'sk-secret-paid', baseUrl: up.url('openai') });
  r.gw.updateSettings({ pricing: PRICING, costMode: 'freeFirst', dailyBudgetUsd: 0, monthlyBudgetUsd: 0, tokenSaver: false });
  await r.gw.catalog.refresh({ force: true });
});
after(async () => { await r.close(); await up.close(); });
beforeEach(() => {
  up.calls.length = 0;
  for (const c of r.gw.connections()) r.gw.health.reset(c.id);
  r.gw.cache.clear();
  r.gw.updateSettings({ costMode: 'freeFirst', dailyBudgetUsd: 0, monthlyBudgetUsd: 0, tokenSaver: false });
});

/* ── Tarification ── */
test('pricing : gratuit = 0, payant connu / inconnu / surchargé', () => {
  assert.deepEqual(priceOf('groq', 'llama-3.3-70b-versatile'), { in: 0, out: 0, known: true, free: true });
  assert.equal(priceOf('openai', 'gpt-4o-mini').in, 0.15);
  assert.equal(priceOf('anthropic', 'claude-sonnet-4-5').out, 15);
  assert.equal(priceOf('openai', 'modele-inconnu').known, false);
  assert.equal(priceOf('openai', 'gpt-4o', { 'openai/gpt-4o': { in: 1, out: 2 } }).out, 2);
  assert.ok(Math.abs(estimateCost('openai', 'gpt-4o-mini', 1e6, 1e6) - 0.75) < 1e-9);
  assert.equal(estimateCost('groq', 'x', 1e9, 1e9), 0);
});

/* ── Mode de coût ── */
test('freeOnly refuse un modèle payant explicite (403 cost_policy) sans appeler le fournisseur', async () => {
  r.gw.updateSettings({ costMode: 'freeOnly' });
  const res = await chat('openai/openai-model-a');
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.type, 'cost_policy');
  assert.equal(up.calls.filter((c) => c.name === 'openai' && c.path === '/chat/completions').length, 0);
});

test('freeFirst : phenix/auto choisit un fournisseur gratuit même si un payant est prêt', async () => {
  const res = await chat('phenix/auto');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-phenix-provider'), 'groq');
});

test('phenix/free n\'utilise jamais un fournisseur payant', async () => {
  r.gw.updateConnection(r.gw.db.connections.find((c) => c.provider === 'groq').id, { enabled: false });
  await r.gw.catalog.refresh({ force: true });
  const res = await chat('phenix/free');
  assert.notEqual(res.status, 200);
  assert.equal(up.calls.filter((c) => c.name === 'openai' && c.path === '/chat/completions').length, 0);
  r.gw.updateConnection(r.gw.db.connections.find((c) => c.provider === 'groq').id, { enabled: true });
  await r.gw.catalog.refresh({ force: true });
});

test('alias hérités : phenixRouter-free ≡ phenix/free et « auto » reste valide', async () => {
  assert.equal((await chat('phenixRouter-free')).status, 200);
  assert.equal((await chat('auto')).status, 200);
});

test('modèle payant explicite : appel OK, coût estimé enregistré dans le grand livre REA', async () => {
  const before = r.gw.spend().day;
  const res = await chat('openai/openai-model-a');
  assert.equal(res.status, 200);
  const ex = r.gw.ledger.recent(1)[0];
  assert.ok(Math.abs(ex.costUsd - 0.00021) < 1e-9, `coût ${ex.costUsd}`); // 11 tok × 10 + 5 tok × 20 par million
  assert.ok(r.gw.spend().day > before);
  assert.equal(r.gw.ledger.verifyDuality().ok, true);
  assert.ok(r.gw.ledger.summary().total.costUsd > 0);
});

test('budget quotidien : le payant est bloqué une fois atteint, le gratuit reste disponible', async () => {
  await chat('openai/openai-model-a');
  r.gw.updateSettings({ dailyBudgetUsd: 0.0001 });
  const blocked = await chat('openai/openai-model-a');
  assert.equal(blocked.status, 403);
  assert.match((await blocked.json()).error.message, /budget quotidien/);
  assert.equal((await chat('groq/groq-model-a')).status, 200);
});

test('/v1/models expose free / tier / prix indicatif', async () => {
  const j = await (await r.api('/v1/models?all=1')).json();
  const paid = j.data.find((m) => m.id === 'openai/openai-model-a');
  const free = j.data.find((m) => m.id === 'groq/groq-model-a');
  assert.equal(paid.free, false);
  assert.equal(paid.pricing_usd_per_mtok.input, 10);
  assert.equal(free.free, true);
  assert.ok(j.data.some((m) => m.id === 'phenix/free') && j.data.some((m) => m.id === 'phenix/best'));
});

/* ── Priorités ── */
test('priorité des connexions : le niveau 1 passe avant le niveau 5, rotation au sein d\'un niveau', () => {
  const a = r.gw.addConnection({ provider: 'cerebras', name: 'c-low', apiKey: 'csk_aaaaaaaaaa', priority: 5 });
  const b = r.gw.addConnection({ provider: 'cerebras', name: 'c-top1', apiKey: 'csk_bbbbbbbbbb', priority: 1 });
  const c = r.gw.addConnection({ provider: 'cerebras', name: 'c-top2', apiKey: 'csk_cccccccccc', priority: 1 });
  const seen = new Set();
  for (let i = 0; i < 6; i += 1) {
    const list = r.gw.usableConnections('cerebras');
    assert.notEqual(list[0].id, a.id, 'la priorité basse ne doit jamais passer en premier');
    assert.equal(list.at(-1).id, a.id);
    seen.add(list[0].id);
  }
  assert.deepEqual([...seen].sort(), [b.id, c.id].sort());
  for (const x of [a, b, c]) r.gw.deleteConnection(x.id);
});

/* ── Token Saver ── */
test('Token Saver : réduit les gros résultats d\'outils, épargne système et dernier message', () => {
  const big = `${'ligne de log identique\n'.repeat(400)}FIN`;
  const body = { messages: [
    { role: 'system', content: 'S'.repeat(20000) },
    { role: 'user', content: 'U'.repeat(20000) },
    { role: 'tool', tool_call_id: 't1', content: big + 'X'.repeat(30000) },
    { role: 'user', content: 'D'.repeat(20000) },
  ] };
  const out = saveTokens(body, 4000);
  assert.ok(out.savedChars > 20000);
  assert.equal(out.body.messages[0].content.length, 20000);
  assert.equal(out.body.messages[3].content.length, 20000);
  assert.ok(out.body.messages[2].content.length < 4500);
  assert.ok(out.body.messages[1].content.length < 9000);
  assert.equal(body.messages[2].content.length > 30000, true, 'le corps d\'origine n\'est pas modifié');
  assert.match(tidy('erreur xyz\nerreur xyz\nerreur xyz\nerreur xyz\n\n\n\nb'), /répétée 3 fois/);
  assert.match(squeeze('z'.repeat(10000), 1000), /omis par PhenixRouter Token Saver/);
  assert.equal(saveTokens({ messages: [{ role: 'user', content: 'court' }] }).savedChars, 0);
});

test('Token Saver activé : l\'amont reçoit un message d\'outil raccourci', async () => {
  r.gw.updateSettings({ tokenSaver: true, tokenSaverMaxChars: 2000 });
  const res = await r.api('/v1/chat/completions', { method: 'POST', body: { model: 'groq/groq-model-a', messages: [
    { role: 'user', content: 'lis' }, { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'cat', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'Q'.repeat(50000) }, { role: 'user', content: 'résume' },
  ] } });
  assert.equal(res.status, 200);
  const sent = up.calls.filter((c) => c.path === '/chat/completions').at(-1).body.messages.find((m) => m.role === 'tool').content;
  assert.ok(sent.length < 2600, `longueur ${sent.length}`);
});

/* ── Audio ── */
test('multipart : lecture et réécriture du champ model sans altérer le fichier binaire', () => {
  const b = 'XYZ';
  const bin = Buffer.from([0, 255, 1, 254, 13, 10, 77]);
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="model"\r\n\r\nauto\r\n--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`, 'latin1'),
    bin, Buffer.from(`\r\n--${b}--\r\n`, 'latin1'),
  ]);
  assert.equal(multipartModel(body), 'auto');
  const out = setMultipartModel(body, b, 'whisper-large-v3-turbo');
  assert.equal(multipartModel(out), 'whisper-large-v3-turbo');
  assert.ok(out.includes(bin));
  const noModel = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n\r\nDATA\r\n--${b}--\r\n`, 'latin1');
  assert.equal(multipartModel(setMultipartModel(noModel, b, 'm1')), 'm1');
});

test('/v1/audio/transcriptions : bascule vers Groq (gratuit) avec le modèle par défaut', async () => {
  let seen = null;
  const stt = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seen = { url: req.url, model: multipartModel(Buffer.concat(chunks)), auth: req.headers.authorization };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: 'bonjour' }));
  });
  await new Promise((ok) => stt.listen(0, '127.0.0.1', ok));
  const conn = r.gw.addConnection({ provider: 'groq', name: 'groq-stt', apiKey: 'gsk_stt_key_1234', baseUrl: `http://127.0.0.1:${stt.address().port}/openai/v1`, priority: 1 });
  try {
    const b = 'BND';
    const body = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="model"\r\n\r\nauto\r\n--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\nRIFF\r\n--${b}--\r\n`, 'latin1');
    const res = await fetch(`${r.app.url}/v1/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${r.apiKey}`, 'content-type': `multipart/form-data; boundary=${b}` }, body });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).text, 'bonjour');
    assert.equal(seen.model, 'whisper-large-v3-turbo');
    assert.equal(seen.auth, 'Bearer gsk_stt_key_1234');
    assert.equal(res.headers.get('x-phenix-model'), 'groq/whisper-large-v3-turbo');
  } finally {
    r.gw.deleteConnection(conn.id);
    await new Promise((ok) => { stt.closeAllConnections?.(); stt.close(ok); });
  }
});

test('/v1/audio/transcriptions sans fournisseur audio utilisable → 503 explicite', async () => {
  const gw = r.gw;
  const ids = gw.db.connections.filter((c) => c.provider === 'groq' || c.provider === 'openai').map((c) => [c.id, c.enabled]);
  ids.forEach(([id]) => gw.updateConnection(id, { enabled: false }));
  try {
    const b = 'B2';
    const body = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n\r\nR\r\n--${b}--\r\n`, 'latin1');
    const res = await fetch(`${r.app.url}/v1/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${r.apiKey}`, 'content-type': `multipart/form-data; boundary=${b}` }, body });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error.message, /Groq|OpenAI/);
  } finally {
    ids.forEach(([id, en]) => gw.updateConnection(id, { enabled: en }));
  }
});

/* ── Import d'un config.json « phenixRouter v3 » ── */
test('import legacy : ignore les clés à remplacer, mappe google→gemini, garde priorité et état', () => {
  const out = importLegacyConfig(r.gw, { admin_key: 'phenixRouter_ADMIN_2026', accounts: [
    { id: 'google_free_1', provider: 'google', api_key: 'AIzaSyFAKEFAKEFAKE1234', active: true, priority: 1 },
    { id: 'groq_free_1', provider: 'groq', api_key: 'A_REMPACER_TA_CLE_GROQ_GRATUITE_ICI', active: true, priority: 1 },
    { id: 'hf_off', provider: 'huggingface', api_key: 'hf_FAKEFAKEFAKE1234', active: false, priority: 3 },
    { id: 'zzz', provider: 'inconnu', api_key: 'abcdefghijkl' },
  ] });
  assert.equal(out.imported, 2);
  assert.equal(out.skipped.length, 2);
  const g = r.gw.db.connections.find((c) => c.name === 'google_free_1');
  assert.equal(g.provider, 'gemini');
  assert.equal(g.priority, 1);
  assert.equal(r.gw.db.connections.find((c) => c.name === 'hf_off').enabled, false);
  assert.equal(importLegacyConfig(r.gw, { accounts: [{ id: 'google_free_1', provider: 'google', api_key: 'AIzaSyFAKEFAKEFAKE1234' }] }).imported, 0);
  assert.equal(JSON.stringify(r.gw.db).includes('phenixRouter_ADMIN_2026'), false);
});

test('/health (alias de /healthz) expose le mode de coût', async () => {
  const j = await (await fetch(`${r.app.url}/health`)).json();
  assert.equal(j.ok, true);
  assert.equal(j.costMode, 'freeFirst');
});
