// Copyright (c) 2026 Fido-labs —kcw—
// Tests d'exploitation : sonde de santé des clés.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRouter } from './helpers.js';

let r; let server; let mode = 'ok'; let hits = 0; let base;

before(async () => {
  server = http.createServer((req, res) => {
    hits += 1;
    if (mode === '401') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"bad key"}}'); return; }
    if (mode === '500') { res.writeHead(500); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'm-a' }, { id: 'm-b' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/v1`;
  r = await createRouter();
});
after(async () => { await r.close(); await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }); });

test('sonde : clé valide → OK, résultat exposé dans la connexion', async () => {
  const conn = r.gw.addConnection({ provider: 'groq', name: 'sonde-ok', apiKey: 'gsk_a', baseUrl: base });
  const out = await r.gw.monitor.sweep({ force: true });
  const mine = out.find((x) => x.id === conn.id);
  assert.equal(mine.ok, true);
  assert.equal(mine.models, 2);
  const pub = r.gw.connections().filter((c) => c.id === conn.id).map((c) => r.gw.publicConnection(c))[0];
  assert.equal(pub.probe.ok, true);
  assert.ok(!JSON.stringify(pub).includes('gsk_a'));
});

test('sonde : clé révoquée (401) → pause « auth », journal d’alerte, puis rétablissement', async () => {
  const conn = r.gw.addConnection({ provider: 'groq', name: 'sonde-ko', apiKey: 'gsk_b', baseUrl: base });
  mode = '401';
  await r.gw.monitor.sweep({ force: true });
  const res = r.gw.monitor.get(conn.id);
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
  assert.equal(r.gw.health.available(conn.id), false, 'la clé morte doit être mise en pause');
  assert.ok(r.gw.logs.some((l) => /sonde.*sonde-ko.*échec/.test(l.message) && l.level === 'warn'));
  const warns = r.gw.logs.filter((l) => /sonde-ko/.test(l.message)).length;
  await r.gw.monitor.sweep({ force: true });
  assert.equal(r.gw.logs.filter((l) => /sonde-ko/.test(l.message)).length, warns, 'pas de spam d’alertes');
  mode = 'ok';
  r.gw.health.reset(conn.id);
  await r.gw.monitor.sweep({ force: true });
  assert.equal(r.gw.monitor.get(conn.id).ok, true);
  assert.ok(r.gw.logs.some((l) => /sonde-ko.*de nouveau opérationnelle/.test(l.message)));
});

test('sonde : connexions servies récemment ignorées, balayage non concurrent', async () => {
  const conn = r.gw.addConnection({ provider: 'groq', name: 'sonde-recente', apiKey: 'gsk_c', baseUrl: base });
  r.gw.health.success(conn.id, 50);
  const out = await r.gw.monitor.sweep();
  assert.ok(!out.some((x) => x.id === conn.id), 'une connexion qui vient de réussir n’est pas resondée');
  r.gw.monitor.running = true;
  assert.deepEqual(await r.gw.monitor.sweep({ force: true }), []);
  r.gw.monitor.running = false;
});

test('sonde : réglage probeIntervalMin borné, minuteur piloté et arrêté proprement', () => {
  assert.equal(r.gw.settings().probeIntervalMin, 30);
  assert.equal(r.gw.updateSettings({ probeIntervalMin: 99999 }).probeIntervalMin, 1440);
  assert.equal(r.gw.updateSettings({ probeIntervalMin: 0 }).probeIntervalMin, 0);
  r.gw.monitor.start();
  assert.equal(r.gw.monitor.timer, null, '0 = désactivée');
  r.gw.updateSettings({ probeIntervalMin: 5 });
  assert.ok(r.gw.monitor.timer, 'le minuteur démarre quand la sonde est activée');
  r.gw.monitor.stop();
  assert.equal(r.gw.monitor.timer, null);
});

test('sonde : fournisseur sans découverte → non vérifiable (ok:null), jamais d’appel payant', async () => {
  const conn = r.gw.addConnection({ provider: 'openai', name: 'oa-statique', apiKey: 'sk-x', baseUrl: base });
  const out = await r.gw.monitor.sweep({ force: true });
  const mine = out.find((x) => x.id === conn.id);
  assert.ok(mine);
  assert.notEqual(mine.ok, false, 'un fournisseur non vérifiable ne doit jamais être déclaré en panne');
});

/* ───────── Service permanent ───────── */
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manageService, systemdUnit, launchdPlist, schtasksCreate, launcher, startArgs } from '../src/core/service.js';
import { runDoctor } from '../src/core/doctor.js';

test('service : commande de relance (node + script, ou exécutable autonome) et arguments', () => {
  assert.deepEqual(launcher({ execPath: '/usr/bin/node', script: 'bin/phenixrouter.js' }).args.length, 1);
  assert.deepEqual(launcher({ execPath: '/opt/phenixrouter-linux-x64', script: 'x' }), { cmd: '/opt/phenixrouter-linux-x64', args: [] });
  assert.deepEqual(startArgs({ port: 3000, host: '0.0.0.0' }), ['start', '--no-browser', '--port', '3000', '--host', '0.0.0.0']);
  assert.deepEqual(startArgs(), ['start', '--no-browser']);
});

test('service : génération systemd / launchd / schtasks (chemins avec espaces et caractères spéciaux)', () => {
  const spec = { cmd: '/opt/Phenix Router/node', args: ['/opt/Phenix Router/bin/p.js', 'start', '--no-browser'] };
  const unit = systemdUnit(spec);
  assert.match(unit, /ExecStart="\/opt\/Phenix Router\/node" "\/opt\/Phenix Router\/bin\/p\.js" "start" "--no-browser"/);
  assert.match(unit, /Restart=on-failure/);
  const plist = launchdPlist({ cmd: '/a&b/x', args: ['start'] }, '/tmp/l<og>.log');
  assert.ok(plist.includes('/a&amp;b/x') && plist.includes('l&lt;og&gt;.log'));
  const t = schtasksCreate({ cmd: 'C:\\Program Files\\P\\p.exe', args: ['start'] });
  assert.deepEqual(t.slice(0, 7), ['/Create', '/F', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TN']);
  assert.equal(t.at(-1), '"C:\\Program Files\\P\\p.exe" "start"');
});

test('service : installation / état / retrait sous Linux (commandes système simulées, rien d’exécuté)', () => {
  const home = mkdtempSync(join(tmpdir(), 'phx-svc-'));
  const ran = [];
  const run = (file, args) => { ran.push([file, ...args].join(' ')); if (args.includes('is-active')) return 'active\n'; return ''; };
  const spec = { cmd: '/usr/bin/node', args: ['/x/p.js', 'start', '--no-browser'] };
  const r = manageService('install', { platform: 'linux', home, run, spec });
  const file = join(home, '.config/systemd/user/phenixrouter.service');
  assert.equal(r.file, file);
  assert.ok(readFileSync(file, 'utf8').includes('ExecStart='));
  assert.deepEqual(ran, ['systemctl --user daemon-reload', 'systemctl --user enable --now phenixrouter.service']);
  assert.equal(manageService('status', { platform: 'linux', home, run, spec }).state, 'active');
  manageService('uninstall', { platform: 'linux', home, run, spec });
  assert.equal(existsSync(file), false);
  assert.throws(() => manageService('install', { platform: 'linux', home, run: () => { throw Object.assign(new Error('x'), { stderr: 'Failed to connect to bus' }); }, spec }), /Failed to connect to bus/);
  assert.throws(() => manageService('install', { platform: 'plan9', home, run, spec }), /non pris en charge/);
  rmSync(home, { recursive: true, force: true });
});

test('service : macOS (plist) et Windows (schtasks)', () => {
  const home = mkdtempSync(join(tmpdir(), 'phx-svc-'));
  const ran = [];
  const run = (f, a) => { ran.push([f, ...a].join(' ')); return 'ok'; };
  const spec = { cmd: '/Applications/phenixrouter', args: ['start'] };
  const m = manageService('install', { platform: 'darwin', home, run, spec });
  assert.ok(existsSync(m.file) && ran.some((c) => c.startsWith('launchctl load -w')));
  manageService('uninstall', { platform: 'darwin', home, run, spec });
  assert.equal(existsSync(m.file), false);
  ran.length = 0;
  manageService('install', { platform: 'win32', home, run, spec: { cmd: 'C:\\p.exe', args: ['start'] } });
  assert.ok(ran[0].startsWith('schtasks /Create /F /SC ONLOGON /RL LIMITED'));
  assert.ok(ran.some((c) => c.startsWith('schtasks /Run')));
  rmSync(home, { recursive: true, force: true });
});

test('doctor : diagnostic complet, version de Node trop ancienne et dossier inaccessible détectés', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-doc-'));
  const rows = await runDoctor({ dataDir: dir, port: 0, probeNetwork: false, env: { GROQ_API_KEY: 'x' } });
  const by = Object.fromEntries(rows.map((x) => [x.name, x]));
  assert.equal(by['Node.js'].status, 'ok');
  assert.equal(by['Dossier de données'].status, 'ok');
  assert.equal(by['Clés (environnement)'].status, 'ok');
  assert.match(by['Clés (environnement)'].detail, /Groq/);
  assert.equal((await runDoctor({ dataDir: dir, port: 0, probeNetwork: false, nodeVersion: '18.19.0', env: {} })).find((x) => x.name === 'Node.js').status, 'fail');
  writeFileSync(join(dir, 'fichier'), 'x');
  const bad = await runDoctor({ dataDir: join(dir, 'fichier', 'sous-dossier'), port: 0, probeNetwork: false, env: {} });
  assert.equal(bad.find((x) => x.name === 'Dossier de données').status, 'fail');
  rmSync(dir, { recursive: true, force: true });
});
