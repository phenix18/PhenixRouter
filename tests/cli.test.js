// Copyright (c) 2026 Fido-labs —kcw—
// Tests CLI : identifiants conservés, info, connect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Gateway } from '../src/gateway.js';

const BIN = join(import.meta.dirname, '..', 'bin', 'phenixrouter.js');
const run = (dir, ...args) => spawnSync(process.execPath, [BIN, ...args, '--data-dir', dir, '--port', '1'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

test('premier lancement : identifiants copiés dans credentials.txt (0600) ; info affiche Base URL et clés', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-cli-'));
  const gw = new Gateway({ dataDir: dir });
  const creds = gw.ensureCredentials();
  gw.close();
  assert.ok(creds.credentialsFile && existsSync(creds.credentialsFile));
  const txt = readFileSync(creds.credentialsFile, 'utf8');
  assert.ok(txt.includes(creds.password) && txt.includes(creds.apiKey));
  if (process.platform !== 'win32') assert.equal(statSync(creds.credentialsFile).mode & 0o077, 0);
  const info = run(dir, 'info');
  assert.match(info.stdout, /Base URL OpenAI\s+http:\/\/127\.0\.0\.1:1\/v1/);
  assert.match(info.stdout, /Base URL Claude Code/);
  assert.ok(info.stdout.includes(creds.apiKey.slice(0, 8)));
  assert.ok(!info.stdout.includes(creds.apiKey), 'la clé complète n’est jamais réaffichée par info');
  rmSync(dir, { recursive: true, force: true });
});

test('connect : ajoute une clé fournisseur sans tableau de bord ; fournisseur inconnu refusé', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-cli-'));
  const ok = run(dir, 'connect', 'groq', 'gsk_test_1234');
  assert.equal(ok.status ?? 0, 0, ok.stderr);
  const gw = new Gateway({ dataDir: dir });
  assert.ok(gw.connections().some((c) => c.provider === 'groq' && c._key === 'gsk_test_1234'));
  gw.close();
  const bad = run(dir, 'connect', 'inconnu', 'x');
  assert.notEqual(bad.status, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('bascule de port : si le port est occupé, le suivant est utilisé ; --strict-port (portFallback 0) échoue', async () => {
  const net = await import('node:net');
  const { start } = await import('../src/server.js');
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const busy = blocker.address().port;
  const dir = mkdtempSync(join(tmpdir(), 'phx-port-'));
  await assert.rejects(start({ port: busy, host: '127.0.0.1', dataDir: dir, portFallback: 0 }), /EADDRINUSE/);
  const app = await start({ port: busy, host: '127.0.0.1', dataDir: dir, portFallback: 9 });
  assert.notEqual(app.port, busy);
  assert.equal(readFileSync(join(dir, 'port'), 'utf8'), String(app.port));
  assert.equal((await fetch(`${app.url}/healthz`)).status, 200);
  await app.close();
  assert.equal(existsSync(join(dir, 'port')), false);
  blocker.close(); rmSync(dir, { recursive: true, force: true });
});

test('codage : familles détectées et score réservé aux modèles avec appel d’outils', async () => {
  const { family, codingScore, inferTags } = await import('../src/providers/tags.js');
  assert.equal(family('anthropic/claude-sonnet-4-5'), 'claude');
  assert.equal(family('openai/gpt-oss-120b'), 'gpt');
  assert.equal(family('z-ai/glm-4.5-air:free'), 'glm');
  assert.equal(family('qwen/qwen3-coder:free'), 'qwen');
  assert.equal(codingScore('bge-m3', ['embedding'], 8000), null);
  const tags = inferTags('qwen/qwen3-coder:free');
  assert.ok(codingScore('qwen/qwen3-coder:free', tags, 262144) > codingScore('llama-3.1-8b-instant', inferTags('llama-3.1-8b-instant'), 131072));
});
