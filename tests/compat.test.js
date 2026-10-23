// Copyright (c) 2026 Fido-labs —kcw—
// Compatibilité des outils clients : noms de modèles étrangers, jeton d'administration local, configuration Claude Code/OpenCode.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMockUpstream, createRouter } from './helpers.js';
import { foreignAlias } from '../src/core/router.js';
import { TOOLS } from '../src/core/clitools.js';

let up; let r;
before(async () => {
  up = await createMockUpstream();
  r = await createRouter();
  r.gw.addConnection({ provider: 'groq', name: 'g', apiKey: 'gsk_x', baseUrl: up.url('groq') });
  await r.gw.catalog.refresh({ force: true });
});
after(async () => { await r.close(); await up.close(); });

test('noms de modèles des outils : claude-*/gpt-* sans clé d’origine → alias PhenixRouter équivalent', async () => {
  assert.equal(foreignAlias('claude-3-5-haiku-20241022'), 'fast');
  assert.equal(foreignAlias('claude-opus-4-1'), 'smart');
  assert.equal(foreignAlias('claude-sonnet-4-5'), 'auto');
  assert.equal(foreignAlias('gpt-5-codex'), 'code');
  assert.equal(foreignAlias('anthropic/claude-sonnet-4-5'), 'auto');
  assert.equal(foreignAlias('llama-3.3-70b'), null);
  for (const model of ['claude-3-5-haiku-20241022', 'claude-sonnet-4-5', 'gpt-5-codex', 'anthropic/claude-opus-4-1']) {
    const res = await r.api('/v1/messages', { method: 'POST', body: { model, max_tokens: 8, messages: [{ role: 'user', content: 'salut' }] } });
    assert.equal(res.status, 200, model);
  }
});

test('Claude Code : en-têtes beta, système en tableau, x-api-key ou Bearer, count_tokens', async () => {
  const body = { model: 'phenix/auto', max_tokens: 16, system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], thinking: { type: 'enabled', budget_tokens: 1024 } };
  const a = await fetch(`${r.app.url}/v1/messages?beta=true`, { method: 'POST', headers: { authorization: `Bearer ${r.apiKey}`, 'content-type': 'application/json', 'anthropic-beta': 'claude-code-20250219' }, body: JSON.stringify(body) });
  assert.equal(a.status, 200);
  const b = await fetch(`${r.app.url}/v1/messages`, { method: 'POST', headers: { 'x-api-key': r.apiKey, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ ...body, stream: true }) });
  assert.equal(b.status, 200);
  assert.match(await b.text(), /message_stop/);
  const c = await fetch(`${r.app.url}/v1/messages/count_tokens?beta=true`, { method: 'POST', headers: { authorization: `Bearer ${r.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'phenix/auto', messages: [{ role: 'user', content: 'hi' }] }) });
  assert.ok((await c.json()).input_tokens > 0);
});

test('configuration : Claude Code reçoit tous les alias de modèles ; OpenCode référence les modèles sans préfixe', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const home = mkdtempSync(join(tmpdir(), 'phx-home-'));
  const f = TOOLS.claude.file(home);
  TOOLS.claude.apply(f, { base: 'http://127.0.0.1:20128/v1', key: 'phx-k' });
  const env = JSON.parse(readFileSync(f, 'utf8')).env;
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:20128', 'sans /v1');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'phx-k');
  assert.ok(env.ANTHROPIC_DEFAULT_HAIKU_MODEL && env.ANTHROPIC_DEFAULT_SONNET_MODEL && env.ANTHROPIC_DEFAULT_OPUS_MODEL);
  const o = TOOLS.opencode.file(home);
  TOOLS.opencode.apply(o, { base: 'http://127.0.0.1:20128', key: 'phx-k' });
  const oc = JSON.parse(readFileSync(o, 'utf8'));
  assert.equal(oc.provider.phenix.options.baseURL, 'http://127.0.0.1:20128/v1');
  assert.ok(oc.provider.phenix.models.auto && oc.model === 'phenix/auto');
});

test('jeton d’administration local : la CLI crée une clé serveur en marche ; refusé via tunnel ou sans jeton', async () => {
  const token = readFileSync(join(r.dir, 'admin.token'), 'utf8');
  const ok = await fetch(`${r.app.url}/api/keys`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-phenix-local-admin': token }, body: JSON.stringify({ name: 'cli-setup' }) });
  assert.equal(ok.status, 201);
  assert.match((await ok.json()).key, /^phx-/);
  const tunnel = await fetch(`${r.app.url}/api/keys`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-phenix-local-admin': token, 'x-forwarded-for': '1.2.3.4' }, body: JSON.stringify({ name: 'x' }) });
  assert.equal(tunnel.status, 401);
  const bad = await fetch(`${r.app.url}/api/keys`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-phenix-local-admin': 'faux' }, body: JSON.stringify({ name: 'x' }) });
  assert.equal(bad.status, 401);
});
