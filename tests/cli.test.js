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
