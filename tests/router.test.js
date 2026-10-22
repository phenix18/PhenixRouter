// Copyright (c) 2026 Fido-labs —kcw—
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModel } from '../src/core/router.js';
import { Health, parseRetryAfter } from '../src/providers/health.js';
import { inferTags, quality, sizeInBillions } from '../src/providers/tags.js';
import { ResponseCache } from '../src/core/cache.js';
import { RateLimiter } from '../src/core/ratelimit.js';
import { isPrivateIp, fetchPublic, htmlToText } from '../src/core/webtools.js';
import { hashPassword, verifyPassword, Vault } from '../src/store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('parseModel : fournisseur explicite, alias court, modèles à slash', () => {
  assert.deepEqual(parseModel('groq/llama-3.3-70b-versatile'), { provider: 'groq', model: 'llama-3.3-70b-versatile' });
  assert.deepEqual(parseModel('gq/openai/gpt-oss-120b'), { provider: 'groq', model: 'openai/gpt-oss-120b' });
  assert.deepEqual(parseModel('openrouter/meta-llama/llama-3.3-70b-instruct:free'), { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free' });
  assert.equal(parseModel('llama-3.3-70b-versatile'), null);
  assert.equal(parseModel('unknown/foo'), null);
});

test('Health : coupe-circuit, repli, rétablissement et score', () => {
  const h = new Health();
  assert.ok(h.available('c'));
  h.failure('c', 'server', 'x');
  assert.ok(!h.available('c'));
  assert.ok(h.cooldownLeftMs('c') > 0);
  h.failure('c', 'rate', 'x', 120_000);
  assert.ok(h.cooldownLeftMs('c') > 100_000);
  h.success('c', 200);
  assert.ok(h.available('c'));
  h.failure('c2', 'client', 'mauvaise requête');
  assert.ok(h.available('c2'), 'une erreur client ne pénalise pas la connexion');
  h.success('fast', 100);
  h.success('slow', 2000);
  assert.ok(h.score('fast') < h.score('slow'));
});

test('parseRetryAfter : en-tête et messages', () => {
  const headers = new Headers({ 'retry-after': '7' });
  assert.equal(parseRetryAfter(headers, ''), 7000);
  assert.equal(parseRetryAfter(new Headers(), 'Please try again in 7m12.5s.'), 7 * 60_000 + 12_500);
  assert.equal(parseRetryAfter(new Headers(), 'retry after 250ms'), 250);
  assert.equal(parseRetryAfter(new Headers(), 'rien'), 0);
});

test('Étiquettes et qualité des modèles', () => {
  assert.ok(inferTags('nvidia/nv-embed-v1').includes('embedding'));
  assert.ok(inferTags('qwen/qwen3-coder:free').includes('code'));
  assert.ok(inferTags('meta/llama-3.3-70b-instruct').includes('large'));
  assert.ok(inferTags('llama-3.1-8b-instant').includes('small'));
  assert.ok(inferTags('gemini-2.5-flash').includes('vision'));
  assert.equal(sizeInBillions('mixtral-8x7b'), 56);
  assert.ok(quality('llama-3.3-70b-versatile') > quality('llama-3.1-8b-instant'));
});

test('Cache LRU : TTL, éviction et clé stable', async () => {
  const c = new ResponseCache({ max: 2, ttlMs: 50 });
  const k = (o) => ResponseCache.key(o);
  assert.equal(k({ a: 1, b: 2 }), k({ b: 2, a: 1 }));
  c.set('a', { v: 1 }); c.set('b', { v: 2 }); c.set('c', { v: 3 });
  assert.equal(c.get('a'), undefined, 'a évincé');
  assert.deepEqual(c.get('c'), { v: 3 });
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(c.get('c'), undefined, 'expiré');
});

test('Limiteur de débit à fenêtre glissante', () => {
  const l = new RateLimiter();
  assert.ok(l.hit('k', 2).ok);
  assert.ok(l.hit('k', 2).ok);
  const r = l.hit('k', 2);
  assert.ok(!r.ok);
  assert.ok(r.retryAfterSec >= 1);
  assert.ok(l.hit('k', 0).ok, '0 = illimité');
});

test('Garde SSRF : adresses privées refusées', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0']) {
    assert.ok(isPrivateIp(ip), ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.ok(!isPrivateIp(ip), ip);
  await assert.rejects(fetchPublic('http://127.0.0.1:1/'), /non autorisée/);
  await assert.rejects(fetchPublic('http://localhost/'), /local/);
  await assert.rejects(fetchPublic('file:///etc/passwd'), /http/);
  await assert.rejects(fetchPublic('http://169.254.169.254/latest/meta-data'), /non autorisée/);
});

test('htmlToText retire scripts, styles et balises', () => {
  const { title, text } = htmlToText('<html><head><title>Titre &amp; co</title><style>a{}</style></head><body><script>alert(1)</script><h1>Salut</h1><p>le monde</p></body></html>');
  assert.equal(title, 'Titre & co');
  assert.ok(text.includes('Salut'));
  assert.ok(!text.includes('alert'));
  assert.ok(!text.includes('<'));
});

test('Mots de passe (scrypt) et coffre AES-GCM', () => {
  const h = hashPassword('secret-123');
  assert.ok(verifyPassword('secret-123', h));
  assert.ok(!verifyPassword('autre', h));
  const dir = mkdtempSync(join(tmpdir(), 'phx-vault-'));
  try {
    const v = new Vault(dir);
    const sealed = v.seal('gsk_ma_cle_secrete');
    assert.ok(sealed.startsWith('enc1:'));
    assert.ok(!sealed.includes('gsk_'));
    assert.equal(v.open(sealed), 'gsk_ma_cle_secrete');
    assert.equal(new Vault(dir).open(sealed), 'gsk_ma_cle_secrete', 'la clé persiste');
    assert.throws(() => v.open(`${sealed.slice(0, -4)}AAAA`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
