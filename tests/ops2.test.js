// Copyright (c) 2026 Fido-labs —kcw—
// Tests d'exploitation (2) : quotas par clé, audit chaîné, sauvegarde chiffrée, alertes de budget, cache sémantique.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockUpstream, createRouter } from './helpers.js';
import { AuditLog } from '../src/core/audit.js';
import { createBackup, readBackup, restoreBackup } from '../src/core/backup.js';
import { Gateway } from '../src/gateway.js';
import { semanticSignature, similarity } from '../src/core/cache.js';

let up; let r;
const chat = (key, model = 'groq/groq-model-a', content = 'salut') => r.api('/v1/chat/completions', { method: 'POST', key, body: { model, messages: [{ role: 'user', content }] } });

before(async () => {
  up = await createMockUpstream();
  r = await createRouter();
  r.gw.addConnection({ provider: 'groq', name: 'groq-1', apiKey: 'gsk_secret_one', baseUrl: up.url('groq') });
  r.gw.addConnection({ provider: 'cerebras', name: 'cb-1', apiKey: 'csk_secret_two', baseUrl: up.url('cerebras') });
  await r.gw.catalog.refresh({ force: true });
});
after(async () => { await r.close(); await up.close(); });

/* ───────── Quotas par clé ───────── */

test('quotas : noms de clés uniques, normalisation, liste de modèles autorisés', async () => {
  const a = r.gw.createApiKey('equipe', { allowedModels: 'groq/*, phenix/free', dailyRequests: 2 });
  const b = r.gw.createApiKey('equipe');
  assert.notEqual(a.record.name, b.record.name, 'un nom de clé = une identité de quota');
  assert.deepEqual(a.record.allowedModels, ['groq/*', 'phenix/free']);
  assert.equal(a.record.dailyRequests, 2);
  const bad = r.gw.createApiKey('x', { allowedModels: ['ok/*', '<script>', ''], dailyBudgetUsd: -5, monthlyBudgetUsd: 'abc' });
  assert.deepEqual(bad.record.allowedModels, ['ok/*']);
  assert.equal(bad.record.dailyBudgetUsd, 0);
  assert.equal(bad.record.monthlyBudgetUsd, 0);
});

test('quotas : modèle hors liste → 403, modèle autorisé → 200 ; cache et chemins alternatifs aussi contrôlés', async () => {
  const k = r.gw.createApiKey('restreinte', { allowedModels: ['groq/*'] }).key;
  assert.equal((await chat(k, 'groq/groq-model-a')).status, 200);
  const no = await chat(k, 'cerebras/cerebras-model-a');
  assert.equal(no.status, 403);
  assert.equal((await no.json()).error.code, 'model_not_allowed');
  assert.equal((await chat(k, 'phenix/auto')).status, 403, 'phenix/auto n’est pas dans la liste');
  const emb = await r.api('/v1/embeddings', { method: 'POST', key: k, body: { model: 'cerebras/x', input: 'a' } });
  assert.equal(emb.status, 403);
  const anth = await r.api('/v1/messages', { method: 'POST', key: k, body: { model: 'cerebras/cerebras-model-a', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] } });
  assert.equal(anth.status, 403);
});

test('quotas : requêtes/jour épuisées → 429 quota_exceeded ; autre clé non affectée ; clé expirée → 401', async () => {
  const k = r.gw.createApiKey('petit-quota', { dailyRequests: 2 }).key;
  assert.equal((await chat(k)).status, 200);
  assert.equal((await chat(k, 'groq/groq-model-a', 'deux')).status, 200);
  const third = await chat(k, 'groq/groq-model-a', 'trois');
  assert.equal(third.status, 429);
  assert.equal((await third.json()).error.code, 'quota_exceeded');
  assert.equal((await chat(r.apiKey)).status, 200, 'les autres clés ne sont pas touchées');
  const exp = r.gw.createApiKey('expiree', { expiresAt: Date.now() - 1000 }).key;
  assert.equal((await chat(exp)).status, 401);
});

test('quotas : budget quotidien par clé (dépense estimée du grand livre)', async () => {
  const k = r.gw.createApiKey('budget-key', { dailyBudgetUsd: 0.01 });
  r.gw.recordExchange({ ts: Date.now(), client: 'budget-key', route: 'chat', provider: 'openai', model: 'openai/gpt-x', status: 'ok', tokensIn: 1, tokensOut: 1, ms: 1, costUsd: 0.02 });
  const res = await chat(k.key);
  assert.equal(res.status, 429);
  assert.match((await res.json()).error.message, /Budget quotidien de la clé « budget-key »/);
});

test('quotas : mise à jour via updateApiKey (PATCH) sans toucher au reste', () => {
  const k = r.gw.createApiKey('patch-me', { dailyRequests: 5, allowedModels: ['a/*'] });
  const upd = r.gw.updateApiKey(k.record.id, { dailyRequests: 9 });
  assert.equal(upd.dailyRequests, 9);
  assert.deepEqual(upd.allowedModels, ['a/*']);
  assert.equal(upd.enabled, true);
  assert.ok(!('hash' in upd));
});

/* ───────── Audit ───────── */

test('audit : chaîne de hachage valide, altération détectée, reprise après redémarrage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-audit-'));
  const a = new AuditLog(dir);
  a.record({ actor: 'admin', ip: '1.2.3.4', action: 'POST /api/keys', status: 201 });
  a.record({ actor: 'admin', ip: '1.2.3.4', action: 'DELETE /api/keys/:id', status: 200 });
  assert.deepEqual(a.verify(), { ok: true, entries: 2 });
  const b = new AuditLog(dir); // redémarrage : la chaîne continue
  b.record({ actor: 'admin', action: 'PUT /api/settings', status: 200 });
  assert.deepEqual(new AuditLog(dir).verify(), { ok: true, entries: 3 });
  const lines = readFileSync(join(dir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean);
  lines[1] = lines[1].replace('DELETE', 'GET');
  writeFileSync(join(dir, 'audit.jsonl'), `${lines.join('\n')}\n`);
  const v = new AuditLog(dir).verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 2);
  const del = lines.filter((_, i) => i !== 1);
  writeFileSync(join(dir, 'audit.jsonl'), `${del.join('\n')}\n`);
  assert.equal(new AuditLog(dir).verify().reason, 'chaînage rompu');
  rmSync(dir, { recursive: true, force: true });
});

test('audit : les écritures d’administration sont journalisées sans aucune valeur sensible', async () => {
  const res = await fetch(`${r.app.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'mauvais-mot-de-passe' }) });
  assert.equal(res.status, 401);
  const rows = r.gw.audit.recent(10);
  assert.ok(rows.some((e) => e.action === 'login.échec' && e.status === 401));
  const raw = readFileSync(join(r.dir, 'audit.jsonl'), 'utf8');
  assert.ok(!raw.includes('mauvais-mot-de-passe'));
  assert.equal(r.gw.audit.verify().ok, true);
});

/* ───────── Sauvegarde chiffrée ───────── */

test('sauvegarde : aller-retour complet sur une AUTRE machine (autre coffre), mauvais mot de passe refusé', () => {
  const pw = 'correct horse battery';
  const file = createBackup(r.gw, pw);
  assert.ok(!file.includes('gsk_secret_one') && !file.includes('csk_secret_two'), 'aucun secret en clair dans le fichier');
  assert.throws(() => createBackup(r.gw, 'court'), /10 caractères/);
  assert.throws(() => readBackup(file, 'mauvais mot de passe'), /incorrect/);
  const tampered = JSON.parse(file); tampered.data = `${tampered.data.slice(0, -4)}AAAA`;
  assert.throws(() => readBackup(JSON.stringify(tampered), pw), /incorrect|altéré/);
  assert.throws(() => readBackup('{"x":1}', pw), /pas une sauvegarde/);
  const dir2 = mkdtempSync(join(tmpdir(), 'phx-restore-'));
  const gw2 = new Gateway({ dataDir: dir2 });
  const rep = restoreBackup(gw2, file, pw);
  assert.equal(rep.connections, r.gw.db.connections.length);
  const c = gw2.connections().find((x) => x.name === 'groq-1');
  assert.equal(c._key, 'gsk_secret_one', 'la clé est rechiffrée avec le coffre de la nouvelle machine');
  assert.ok(gw2.db.apiKeys.some((k) => k.name === 'restreinte' && k.allowedModels[0] === 'groq/*'));
  assert.equal(gw2.checkPassword('x'), r.gw.checkPassword('x'));
  const raw2 = readFileSync(join(dir2, 'db.json'), 'utf8');
  assert.ok(!raw2.includes('gsk_secret_one'), 'db.json reste chiffré au repos');
  gw2.close();
  rmSync(dir2, { recursive: true, force: true });
});

test('sauvegarde : restauration refusée si structure invalide ; copie de sécurité de l’ancienne configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-restore-'));
  const gw = new Gateway({ dataDir: dir });
  gw.addConnection({ provider: 'groq', name: 'avant', apiKey: 'gsk_avant' });
  gw.store.flush();
  const pw = 'un-mot-de-passe-long';
  const good = createBackup(r.gw, pw);
  const rep = restoreBackup(gw, good, pw);
  assert.ok(rep.safety && existsSync(rep.safety), 'ancienne configuration conservée');
  assert.ok(!gw.db.connections.some((c) => c.name === 'avant'));
  gw.close(); rmSync(dir, { recursive: true, force: true });
});

test('sauvegarde : API admin protégée par session et mot de passe minimal', async () => {
  const noSession = await fetch(`${r.app.url}/api/backup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"0123456789"}' });
  assert.equal(noSession.status, 401);
});

/* ───────── Alertes de budget ───────── */

test('alertes : 80 % puis 100 % du budget quotidien, une seule fois chacune, webhook appelé', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-alert-'));
  const gw = new Gateway({ dataDir: dir });
  const hooks = [];
  const http = await import('node:http');
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { hooks.push(JSON.parse(b)); res.end('ok'); }); });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  gw.updateSettings({ dailyBudgetUsd: 1, alertWebhookUrl: `http://127.0.0.1:${srv.address().port}/hook` });
  const spend = (usd) => gw.recordExchange({ ts: Date.now(), client: 'c', route: 'chat', provider: 'openai', model: 'openai/m', status: 'ok', tokensIn: 1, tokensOut: 1, ms: 1, costUsd: usd });
  spend(0.5);
  assert.equal(gw.logs.filter((l) => /budget/.test(l.message)).length, 0);
  spend(0.35);
  spend(0.01);
  assert.equal(gw.logs.filter((l) => /à 8\d %/.test(l.message)).length, 1, '80 % signalé une fois');
  spend(0.3);
  spend(0.3);
  assert.equal(gw.logs.filter((l) => /budget quotidien atteint/.test(l.message)).length, 1, '100 % signalé une fois');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(hooks.length, 2);
  assert.match(hooks[0].text, /^\[PhenixRouter\] budget quotidien à 8\d %/);
  assert.equal(hooks[1].content, hooks[1].text);
  assert.equal(gw.budgetStatus().day.pct >= 100, true);
  assert.equal(gw.updateSettings({ alertWebhookUrl: 'ftp://x' }).alertWebhookUrl, '', 'seul http(s) accepté');
  srv.close(); gw.close(); rmSync(dir, { recursive: true, force: true });
});

/* ───────── Cache sémantique ───────── */

test('cache sémantique : signature — nombres et négations jamais confondus', () => {
  const sim = (a, b) => similarity(semanticSignature(a), semanticSignature(b));
  assert.ok(sim('Quelle est la capitale de la France ?', 'quelle est la capitale de la france') >= 0.99);
  assert.ok(sim('Quelle est la capitale de la France ?', 'Dis-moi la capitale de la France') < 0.9);
  assert.equal(sim('Combien font 2 + 2 dans ce calcul simple', 'Combien font 2 + 3 dans ce calcul simple'), 0, 'chiffres différents → jamais similaires');
  assert.equal(sim('Je veux que tu sois poli avec moi aujourd hui', 'Je ne veux pas que tu sois poli avec moi aujourd hui'), 0, 'négation différente → jamais similaires');
  assert.equal(sim('', 'abc def ghi'), 0);
});

test('cache sémantique : désactivé par défaut ; activé, réutilise une question quasi identique sans nouvel appel amont', async () => {
  const body = (q, extra = {}) => ({ model: 'groq/groq-model-a', temperature: 0, messages: [{ role: 'system', content: 'Sois bref.' }, { role: 'user', content: q }], ...extra });
  const post = (b) => r.api('/v1/chat/completions', { method: 'POST', body: b });
  const calls = () => up.calls.filter((c) => c.name === 'groq' && c.path === '/chat/completions').length;
  r.gw.updateSettings({ semanticCache: false, cacheEnabled: true });
  await post(body('Quelle est la capitale de la France exactement ?'));
  let n = calls();
  await post(body('quelle est la capitale de la france exactement'));
  assert.equal(calls(), n + 1, 'sans cache sémantique, la variante appelle l’amont');
  r.gw.updateSettings({ semanticCache: true, semanticThreshold: 0.9 });
  r.gw.cache.clear();
  await post(body('Quelle est la capitale de la France exactement ?'));
  n = calls();
  const hit = await post(body('quelle est la capitale de la france exactement'));
  assert.equal(hit.status, 200);
  assert.equal(calls(), n, 'réponse servie par le cache sémantique');
  assert.equal(r.gw.cache.stats().semanticHits, 1);
  await post(body('Quelle est la capitale de la France exactement en 2024 ?'));
  assert.equal(calls(), n + 1, 'un chiffre en plus → appel amont');
  await post(body('quelle est la capitale de la france exactement', { messages: [{ role: 'system', content: 'Autre consigne.' }, { role: 'user', content: 'quelle est la capitale de la france exactement' }] }));
  assert.equal(calls(), n + 2, 'contexte différent → jamais de réutilisation');
  await post({ ...body('quelle est la capitale de la france exactement'), temperature: 0.7 });
  assert.equal(calls(), n + 3, 'température > 0 → pas de cache');
  r.gw.updateSettings({ semanticCache: false });
});
