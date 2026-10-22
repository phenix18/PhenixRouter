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

/* ───────── SOCKS5 ───────── */
import net from 'node:net';
import { fetchViaProxy, parseProxyUrl } from '../src/core/netfetch.js';

/** Faux proxy SOCKS5 (sans auth ou user/mot de passe) qui relaie vers la cible demandée. */
function socks5Server({ auth } = {}) {
  const seen = []; const conns = new Set();
  const server = net.createServer((c) => {
    conns.add(c); c.once('close', () => conns.delete(c));
    let step = 'greet'; let buf = Buffer.alloc(0);
    c.on('error', () => {});
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (step === 'greet' && buf.length >= 2 + buf[1]) {
        const methods = [...buf.subarray(2, 2 + buf[1])]; buf = buf.subarray(2 + buf[1]);
        if (auth) { if (!methods.includes(2)) { c.end(Buffer.from([5, 0xff])); return; } c.write(Buffer.from([5, 2])); step = 'auth'; } else { c.write(Buffer.from([5, 0])); step = 'req'; }
      }
      if (step === 'auth' && buf.length >= 2 && buf.length >= 3 + buf[1] + buf[2 + buf[1]]) {
        const ul = buf[1]; const u = buf.subarray(2, 2 + ul).toString(); const pl = buf[2 + ul]; const p = buf.subarray(3 + ul, 3 + ul + pl).toString();
        buf = buf.subarray(3 + ul + pl);
        if (u === auth.user && p === auth.pass) { c.write(Buffer.from([1, 0])); step = 'req'; } else { c.end(Buffer.from([1, 1])); return; }
      }
      if (step === 'req' && buf.length >= 5 && buf.length >= 7 + buf[4]) {
        const host = buf.subarray(5, 5 + buf[4]).toString(); const port = buf.readUInt16BE(5 + buf[4]); buf = buf.subarray(7 + buf[4]);
        seen.push({ host, port });
        step = 'pipe';
        const out = net.connect(port, host === 'localhost' ? '127.0.0.1' : host, () => {
          c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (buf.length) out.write(buf);
          c.pipe(out); out.pipe(c);
        });
        out.on('error', () => { try { c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); } catch { /* ignore */ } });
        c.on('close', () => out.destroy());
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, seen, close: () => new Promise((r) => { for (const x of conns) x.destroy(); server.close(r); }) })));
}

test('SOCKS5 : requête http:// via proxy sans auth, nom d’hôte résolu côté proxy (socks5h)', async () => {
  const target = http.createServer((req, res) => { res.end(`vu:${req.headers.host}`); });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const socks = await socks5Server();
  const res = await fetchViaProxy(`socks5h://127.0.0.1:${socks.port}`, `http://localhost:${target.address().port}/x`);
  assert.equal(await res.text(), `vu:localhost:${target.address().port}`);
  assert.deepEqual(socks.seen[0], { host: 'localhost', port: target.address().port }, 'le nom est transmis tel quel au proxy');
  target.closeAllConnections?.(); target.close(); await socks.close();
});

test('SOCKS5 : authentification utilisateur/mot de passe, refus si mauvais identifiants', async () => {
  const target = http.createServer((req, res) => { let n = 0; req.on('data', (c) => { n += c.length; }); req.on('end', () => res.end(`recu:${n}`)); });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const socks = await socks5Server({ auth: { user: 'bob', pass: 'p@ss:w/rd' } });
  const ok = await fetchViaProxy(`socks5://bob:${encodeURIComponent('p@ss:w/rd')}@127.0.0.1:${socks.port}`, `http://127.0.0.1:${target.address().port}/`, { method: 'POST', body: 'hello' });
  assert.equal(await ok.text(), 'recu:5');
  await assert.rejects(() => fetchViaProxy(`socks5://bob:mauvais@127.0.0.1:${socks.port}`, `http://127.0.0.1:${target.address().port}/`), /authentification refusée/);
  await assert.rejects(() => fetchViaProxy(`socks5://127.0.0.1:${socks.port}`, `http://127.0.0.1:${target.address().port}/`), /aucune méthode|identifiants/);
  target.closeAllConnections?.(); target.close(); await socks.close();
});

test('SOCKS5 : cible https:// (TLS par-dessus le tunnel) et erreur « connexion refusée » claire', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-s5-'));
  let cert; let key;
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
    cert = readFileSync(join(dir, 'c.pem')); key = readFileSync(join(dir, 'k.pem'));
  } catch { rmSync(dir, { recursive: true, force: true }); return; }
  const { default: https } = await import('node:https');
  const target = https.createServer({ cert, key }, (req, res) => res.end('tls-socks-ok'));
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const socks = await socks5Server();
  const res = await fetchViaProxy(`socks5h://127.0.0.1:${socks.port}`, `https://localhost:${target.address().port}/`, { tlsOptions: { ca: cert } });
  assert.equal(await res.text(), 'tls-socks-ok');
  await assert.rejects(() => fetchViaProxy(`socks5h://127.0.0.1:${socks.port}`, 'http://127.0.0.1:1/'), /connexion refusée/);
  assert.equal(parseProxyUrl('socks5h://h').protocol, 'socks5h:');
  target.closeAllConnections?.(); target.close(); await socks.close(); rmSync(dir, { recursive: true, force: true });
});
