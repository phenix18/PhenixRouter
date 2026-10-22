// Copyright (c) 2026 Fido-labs —kcw—
// Tests de bout en bout : vrai serveur PhenixRouter + faux fournisseurs amont.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockUpstream, createRouter, readSse } from './helpers.js';

let up;
let r;

before(async () => {
  up = await createMockUpstream();
  r = await createRouter();
  // Deux fournisseurs (groq, cerebras) pointés vers le faux amont.
  r.gw.addConnection({ provider: 'groq', name: 'groq-1', apiKey: 'gsk_secret_one', baseUrl: up.url('groq') });
  r.gw.addConnection({ provider: 'cerebras', name: 'cerebras-1', apiKey: 'csk_secret_two', baseUrl: up.url('cerebras') });
  await r.gw.catalog.refresh({ force: true });
});

after(async () => {
  await r.close();
  await up.close();
});

beforeEach(() => {
  for (const k of Object.keys(up.behavior)) delete up.behavior[k];
  up.calls.length = 0;
  for (const c of r.gw.connections()) r.gw.health.reset(c.id);
  r.gw.cache.clear();
  r.gw.limiter.hits.clear();
  r.gw.db.combos.length = 0;
  for (const k of Object.keys(r.gw.db.aliases)) delete r.gw.db.aliases[k];
});

const chatBody = (extra = {}) => ({ model: 'groq/groq-model-a', messages: [{ role: 'user', content: 'Salut' }], ...extra });

test('/healthz répond sans authentification', async () => {
  const res = await fetch(`${r.app.url}/healthz`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('/v1 refuse les requêtes sans clé valide', async () => {
  assert.equal((await r.api('/v1/models', { key: null })).status, 401);
  assert.equal((await r.api('/v1/models', { key: 'phx-nope' })).status, 401);
  assert.equal((await r.api('/v1/models')).status, 200);
});

test('chat non diffusé : clé amont transmise, usage et en-têtes de traçabilité', async () => {
  const res = await r.api('/v1/chat/completions', { method: 'POST', body: chatBody() });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.choices[0].message.content, 'hello from groq');
  assert.equal(j.model, 'groq/groq-model-a');
  assert.equal(j.usage.total_tokens, 16);
  assert.equal(res.headers.get('x-phenix-provider'), 'groq');
  assert.equal(up.calls[0].auth, 'Bearer gsk_secret_one');
  assert.equal(up.calls[0].body.model, 'groq-model-a', 'le préfixe fournisseur est retiré côté amont');
});

test('le grand livre enregistre l’échange avec sa dualité', async () => {
  const before = r.gw.ledger.summary().total.requests;
  await r.api('/v1/chat/completions', { method: 'POST', body: chatBody() });
  const s = r.gw.ledger.summary();
  assert.equal(s.total.requests, before + 1);
  assert.ok(s.byProvider.groq.tokensOut >= 5);
  assert.ok(r.gw.ledger.verifyDuality().ok);
});

test('bascule : 429 chez groq → servi par cerebras, puis groq mis en pause', async () => {
  r.gw.upsertCombo({ name: 'duo', models: ['groq/groq-model-a', 'cerebras/cerebras-model-a'], strategy: 'fallback' });
  up.behavior.groq = '429';
  const res = await r.api('/v1/chat/completions', { method: 'POST', body: chatBody({ model: 'duo' }) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).choices[0].message.content, 'hello from cerebras');
  assert.equal(res.headers.get('x-phenix-attempts'), '2');
  const groqConn = r.gw.connections().find((c) => c.provider === 'groq');
  assert.ok(!r.gw.health.available(groqConn.id), 'groq est en pause');
  up.calls.length = 0;
  await r.api('/v1/chat/completions', { method: 'POST', body: chatBody({ model: 'duo' }) });
  assert.ok(up.calls.every((c) => c.name === 'cerebras'), 'groq n’est plus sollicité pendant la pause');
});

test('bascule sur erreur 500, sur « 200 avec erreur » et sur flux vide', async () => {
  r.gw.upsertCombo({ name: 'duo', models: ['groq/groq-model-a', 'cerebras/cerebras-model-a'] });
  for (const mode of ['500', 'err200', '401']) {
    up.behavior.groq = mode;
    for (const c of r.gw.connections()) r.gw.health.reset(c.id);
    const res = await r.api('/v1/chat/completions', { method: 'POST', body: chatBody({ model: 'duo' }) });
    assert.equal(res.status, 200, mode);
    assert.equal((await res.json()).choices[0].message.content, 'hello from cerebras', mode);
  }
  up.behavior.groq = 'empty';
  for (const c of r.gw.connections()) r.gw.health.reset(c.id);
  const res = await r.api('/v1/chat/completions', { method: 'POST', body: chatBody({ model: 'duo', stream: true }) });
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('hello from '), 'repli sur cerebras malgré le flux vide');
});

test('bascule quand un modèle ne gère pas les outils (400 « not supported »)', async () => {
  r.gw.upsertCombo({ name: 'duo', models: ['groq/groq-model-a', 'cerebras/cerebras-model-a'] });
  up.behavior.groq = '400tools';
  const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } }];
  const res = await r.api('/v1/chat/completions', { method: 'POST', body: chatBody({ model: 'duo', tools, tool_choice: 'required' }) });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.choices[0].message.tool_calls[0].function.name, 'get_weather');
});

test('tous les fournisseurs en échec → 429 si limitation, 502 sinon, avec le détail des tentatives', async () => {
  r.gw.upsertCombo({ name: 'duo', models: ['groq/groq-model-a', 'cerebras/cerebras-model-a'] });
  up.behavior.groq = '429'; up.behavior.cerebras = '429';
  let res = await r.api('/v1/chat/completions', { method: 'POST', body: chatBody({ model: 'duo' }) });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.attempts.length, 2);
  for (const c of r.gw.connections()) r.gw.health.reset(c.id);
  up.behavior.groq = '500'; up.behavior.cerebras = '500';
  res = await r.api('/v1/chat/completions', { method: 'POST', body: chatBody({ model: 'duo' }) });
  assert.equal(res.status, 502);
});

test('modèle sans connexion → 503 explicite', async () => {
  const res = await r.api('/v1/chat/completions', { method: 'POST', body: chatBody({ model: 'gemini/gemini-2.5-flash' }) });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error.message, /clé/i);
});

test('streaming OpenAI : chunks, usage et [DONE]', async () => {
  const res = await r.api('/v1/chat/completions', { method: 'POST', body: chatBody({ stream: true }) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const evs = await readSse(res);
  assert.equal(evs.at(-1).data, '[DONE]');
  const text = evs.filter((e) => e.data && e.data !== '[DONE]').map((e) => JSON.parse(e.data)).map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
  assert.equal(text, 'hello from groq');
});

test('cache : temperature 0 → deuxième appel servi sans solliciter l’amont', async () => {
  const body = chatBody({ temperature: 0 });
  const a = await r.api('/v1/chat/completions', { method: 'POST', body });
  assert.equal(a.headers.get('x-phenix-cache'), 'miss');
  const n = up.calls.length;
  const b = await r.api('/v1/chat/completions', { method: 'POST', body });
  assert.equal(b.headers.get('x-phenix-cache'), 'hit');
  assert.equal(up.calls.length, n);
  assert.deepEqual((await a.json()).choices, (await b.json()).choices);
});

test('Anthropic /v1/messages : réponse complète, outils et flux', async () => {
  let res = await r.api('/v1/messages', {
    method: 'POST', headers: { 'anthropic-version': '2023-06-01' },
    body: { model: 'groq/groq-model-a', max_tokens: 64, system: 'Sois bref', messages: [{ role: 'user', content: 'Salut' }] },
  });
  assert.equal(res.status, 200);
  let j = await res.json();
  assert.equal(j.type, 'message');
  assert.equal(j.content[0].text, 'hello from groq');
  assert.equal(j.stop_reason, 'end_turn');
  assert.equal(up.calls.at(-1).body.messages[0].role, 'system');

  res = await r.api('/v1/messages', {
    method: 'POST',
    body: {
      model: 'groq/groq-model-a', max_tokens: 64, tool_choice: { type: 'any' },
      tools: [{ name: 'get_weather', description: 'x', input_schema: { type: 'object', properties: {} } }],
      messages: [{ role: 'user', content: 'Météo ?' }],
    },
  });
  j = await res.json();
  assert.equal(j.stop_reason, 'tool_use');
  assert.deepEqual(j.content.find((b) => b.type === 'tool_use').input, { city: 'Paris' });

  res = await r.api('/v1/messages', {
    method: 'POST', body: { model: 'groq/groq-model-a', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'Salut' }] },
  });
  const evs = await readSse(res);
  const names = evs.map((e) => e.event);
  assert.equal(names[0], 'message_start');
  assert.equal(names.at(-1), 'message_stop');
  const text = evs.filter((e) => e.event === 'content_block_delta').map((e) => JSON.parse(e.data).delta.text).join('');
  assert.equal(text, 'hello from groq');
});

test('Anthropic : erreurs au format Anthropic', async () => {
  const res = await r.api('/v1/messages', { method: 'POST', body: { model: 'groq/groq-model-a' } });
  assert.equal(res.status, 400);
  const j = await res.json();
  assert.equal(j.type, 'error');
  assert.equal(j.error.type, 'invalid_request_error');
});

test('OpenAI Responses API : objet et flux', async () => {
  let res = await r.api('/v1/responses', { method: 'POST', body: { model: 'groq/groq-model-a', input: 'Salut', instructions: 'Court' } });
  assert.equal(res.status, 200);
  let j = await res.json();
  assert.equal(j.object, 'response');
  assert.equal(j.output[0].content[0].text, 'hello from groq');

  res = await r.api('/v1/responses', { method: 'POST', body: { model: 'groq/groq-model-a', input: 'Salut', stream: true } });
  const evs = await readSse(res);
  assert.equal(evs[0].event, 'response.created');
  assert.equal(evs.at(-1).event, 'response.completed');
});

test('/v1/models : virtuels, combos, alias et modèles découverts (whisper filtré)', async () => {
  r.gw.upsertCombo({ name: 'mon-combo', models: ['groq/groq-model-a'] });
  r.gw.setAlias('rapide', 'groq/groq-model-b');
  const j = await (await r.api('/v1/models')).json();
  const ids = j.data.map((m) => m.id);
  assert.ok(ids.includes('phenix/auto'));
  assert.ok(ids.includes('mon-combo'));
  assert.ok(ids.includes('rapide'));
  assert.ok(ids.includes('groq/groq-model-a'));
  assert.ok(ids.includes('cerebras/cerebras-model-a'));
  assert.ok(!ids.some((id) => id.includes('whisper')));
  const alias = await r.api('/v1/chat/completions', { method: 'POST', body: chatBody({ model: 'rapide' }) });
  assert.equal(up.calls.at(-1).body.model, 'groq-model-b');
  assert.equal(alias.status, 200);
});

test('phenix/auto choisit dynamiquement parmi les modèles prêts et bascule', async () => {
  up.behavior.groq = '500';
  const res = await r.api('/v1/chat/completions', { method: 'POST', body: chatBody({ model: 'phenix/auto' }) });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).choices[0].message.content.startsWith('hello from'));
});

test('embeddings via fournisseur gratuit', async () => {
  r.gw.catalog.live.set('cerebras', { models: [{ model: 'embed-small', ctx: null, tags: ['embedding'] }], at: Date.now(), error: null });
  try {
    const res = await r.api('/v1/embeddings', { method: 'POST', body: { model: 'cerebras/embed-small', input: 'bonjour' } });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.data[0].embedding.length, 3);
  } finally {
    await r.gw.catalog.refresh({ force: true }); // restaure le catalogue réel du faux amont
  }
});

test('limite de débit par clé API', async () => {
  r.gw.updateSettings({ rateLimitPerMin: 2 });
  try {
    const codes = [];
    for (let i = 0; i < 4; i += 1) codes.push((await r.api('/v1/models')).status);
    assert.deepEqual(codes, [200, 200, 429, 429]);
  } finally {
    r.gw.updateSettings({ rateLimitPerMin: 0 });
  }
});

test('administration : session, connexions (clé jamais renvoyée), clés API, réglages', async () => {
  const unauth = await fetch(`${r.app.url}/api/overview`);
  assert.equal(unauth.status, 401);

  const bad = await fetch(`${r.app.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'faux' }) });
  assert.equal(bad.status, 401);

  r.gw.setPassword('motdepasse-test');
  const login = await fetch(`${r.app.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'motdepasse-test' }) });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  const admin = (path, opts = {}) => fetch(`${r.app.url}${path}`, {
    ...opts, headers: { 'content-type': 'application/json', cookie, ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const ov = await (await admin('/api/overview')).json();
  assert.equal(ov.brand.name, 'PhenixRouter');
  assert.match(ov.brand.copyright, /Fido-labs/);
  assert.ok(ov.duality.ok);
  assert.ok(ov.counts.modelsReady >= 4);

  const add = await admin('/api/connections', { method: 'POST', body: { provider: 'mistral', name: 'mistral-test', apiKey: 'sk_supersecret_9999' } });
  assert.equal(add.status, 201);
  const raw = await add.text();
  assert.ok(!raw.includes('supersecret'), 'la clé n’est jamais renvoyée');
  assert.ok(raw.includes('9999'), 'seuls les 4 derniers caractères sont indiqués');
  const stored = JSON.stringify(r.gw.db.connections);
  assert.ok(!stored.includes('supersecret'), 'la clé est chiffrée au repos');

  const providers = await (await admin('/api/providers')).json();
  assert.equal(providers.providers.find((p) => p.id === 'mistral').connections.length, 1);

  const k = await (await admin('/api/keys', { method: 'POST', body: { name: 'cursor' } })).json();
  assert.match(k.key, /^phx-/);
  assert.ok(!('hash' in k.record));
  const viaNew = await r.api('/v1/models', { key: k.key });
  assert.equal(viaNew.status, 200);
  await admin(`/api/keys/${k.record.id}`, { method: 'DELETE' });
  assert.equal((await r.api('/v1/models', { key: k.key })).status, 401);

  const st = await (await admin('/api/settings', { method: 'PUT', body: { cacheTtlSec: 99999999, language: 'xx', autoChainSize: 3 } })).json();
  assert.equal(st.settings.cacheTtlSec, 86400, 'valeurs bornées');
  assert.equal(st.settings.language, 'fr');
  assert.equal(st.settings.autoChainSize, 3);
  r.gw.updateSettings({ autoChainSize: 6 });

  const test = await (await admin('/api/models/test', { method: 'POST', body: { model: 'groq/groq-model-a' } })).json();
  assert.equal(test.ok, true);
  assert.equal(test.reply, 'hello from groq');

  const conn = r.gw.connections().find((c) => c.provider === 'groq');
  const ct = await (await admin(`/api/connections/${conn.id}/test`, { method: 'POST' })).json();
  assert.equal(ct.ok, true);

  const csrf = await fetch(`${r.app.url}/api/settings`, {
    method: 'PUT', headers: { 'content-type': 'application/json', cookie, origin: 'https://evil.example' }, body: '{}',
  });
  assert.equal(csrf.status, 403, 'origine étrangère refusée');

  const exp = await (await admin('/api/export')).text();
  assert.ok(!exp.includes('gsk_secret') && !exp.includes('supersecret'), 'l’export ne contient aucun secret');
});

test('le tableau de bord (session) peut appeler /v1 sans clé API', async () => {
  const login = await fetch(`${r.app.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'motdepasse-test' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const res = await fetch(`${r.app.url}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(chatBody()),
  });
  assert.equal(res.status, 200);
});

test('fichiers statiques : pas de traversée de répertoire', async () => {
  const res = await fetch(`${r.app.url}/..%2f..%2fpackage.json`);
  const text = await res.text();
  assert.ok(!text.includes('"name": "phenixrouter"') || text.includes('<!doctype html>') || text.includes('<!DOCTYPE html>'));
});
