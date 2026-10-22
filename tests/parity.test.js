// Copyright (c) 2026 Fido-labs —kcw—
// Tests de parité FlagshipRouter : proxys, images, vidéo, web, Gemini natif, audio, MCP, outils clients, tunnel.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockUpstream, createRouter } from './helpers.js';
import { fetchViaProxy, parseProxyUrl, maskProxyUrl } from '../src/core/netfetch.js';
import { parseMultipart } from '../src/core/audioext.js';
import { geminiToOpenAI, openAIToGemini } from '../src/core/translate/gemini.js';
import { applyTool, removeTool, TOOLS } from '../src/core/clitools.js';
import { Tunnel } from '../src/core/tunnel.js';

let up; let r; let api; let calls;
const jsonRes = (res, obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

async function createMockApi(handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const call = { method: req.method, url: req.url, headers: req.headers, raw, body: /json/.test(req.headers['content-type'] ?? '') && raw.length ? JSON.parse(raw) : null };
    calls.push(call);
    handler(call, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

const PNG = Buffer.from('iVBORw0KGgo=', 'base64');

before(async () => {
  up = await createMockUpstream();
  r = await createRouter();
  api = r.api;
  r.gw.addConnection({ provider: 'groq', name: 'groq-1', apiKey: 'gsk_secret_one', baseUrl: up.url('groq') });
  await r.gw.catalog.refresh({ force: true });
});
after(async () => { await r.close(); await up.close(); });

/* ───────── Proxys ───────── */

function startProxy({ requireAuth = false } = {}) {
  const log = []; const tunnels = new Set();
  const server = http.createServer((req, res) => { // forward proxy (cibles http://)
    log.push({ kind: 'forward', url: req.url, auth: req.headers['proxy-authorization'] });
    if (requireAuth && !req.headers['proxy-authorization']) { res.writeHead(407); res.end(); return; }
    const u = new URL(req.url);
    const up2 = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers: { ...req.headers, host: u.host } }, (r2) => { res.writeHead(r2.statusCode, r2.headers); r2.pipe(res); });
    req.pipe(up2);
  });
  server.on('connect', (req, sock, head) => { // CONNECT (cibles https://)
    log.push({ kind: 'connect', target: req.url, auth: req.headers['proxy-authorization'] });
    if (requireAuth && !req.headers['proxy-authorization']) { sock.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
    const [host, port] = req.url.split(':');
    tunnels.add(sock); sock.once('close', () => tunnels.delete(sock));
    const out = net.connect(Number(port), host, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) out.write(head); out.pipe(sock); sock.pipe(out); });
    out.on('error', () => sock.destroy());
    sock.on('error', () => out.destroy());
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, log, close: () => new Promise((c) => { server.closeAllConnections?.(); for (const t of tunnels) t.destroy(); server.close(c); }) })));
}

test('proxy : validation d’URL, SOCKS refusé, identifiants masqués', () => {
  assert.throws(() => parseProxyUrl('socks5://h:1'), /SOCKS/);
  assert.throws(() => parseProxyUrl('ftp://h'), /http/);
  assert.throws(() => parseProxyUrl('pas une url'), /invalide/);
  assert.ok(!maskProxyUrl('http://bob:secret@h:8080').includes('secret'));
});

test('proxy : requête http:// en « forward proxy » avec authentification, corps POST transmis', async () => {
  const target = await createMockApi((c, res) => jsonRes(res, { got: c.body, host: c.headers.host }));
  const proxy = await startProxy({ requireAuth: true });
  const url = new URL(proxy.url); url.username = 'bob'; url.password = 'pw';
  const res = await fetchViaProxy(url.toString(), `${target.base}/x?y=1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 1 }) });
  const j = await res.json();
  assert.deepEqual(j.got, { a: 1 });
  assert.equal(proxy.log[0].kind, 'forward');
  assert.ok(proxy.log[0].auth.startsWith('Basic '));
  const denied = await fetchViaProxy(proxy.url, `${target.base}/x`);
  assert.equal(denied.status, 407);
  await proxy.close(); await target.close();
});

test('proxy : tunnel CONNECT vers une cible https:// (certificat auto-signé généré à la volée)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-tls-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  } catch { t.skip('openssl indisponible'); rmSync(dir, { recursive: true, force: true }); return; }
  const cert = readFileSync(join(dir, 'c.pem')); const key = readFileSync(join(dir, 'k.pem'));
  const target = https.createServer({ cert, key }, (req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('secure-ok'); });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const proxy = await startProxy();
  const res = await fetchViaProxy(proxy.url, `https://localhost:${target.address().port}/`, { tlsOptions: { ca: cert } });
  assert.equal(await res.text(), 'secure-ok');
  assert.equal(proxy.log[0].kind, 'connect');
  assert.match(proxy.log[0].target, /^localhost:\d+$/);
  await proxy.close(); target.closeAllConnections?.(); target.close(); rmSync(dir, { recursive: true, force: true });
});

test('proxy : connexion fournisseur routée par le proxy, et ÉCHEC FERMÉ si le proxy disparaît', async () => {
  const proxy = await startProxy();
  const rec = r.gw.addProxy({ name: 'p1', url: proxy.url });
  assert.ok(!JSON.stringify(r.gw.listProxies()).includes('secret'));
  const conn = r.gw.addConnection({ provider: 'cerebras', name: 'cb-proxy', apiKey: 'csk-x', baseUrl: up.url('cerebras'), proxyId: rec.id });
  await r.gw.catalog.refresh({ force: true });
  up.calls.length = 0;
  const ok = await api('/v1/chat/completions', { method: 'POST', body: { model: 'cerebras/cerebras-model-a', messages: [{ role: 'user', content: 'salut' }] } });
  assert.equal(ok.status, 200);
  assert.ok(proxy.log.some((l) => l.kind === 'forward' && l.url.includes('/cerebras/v1/chat/completions')), 'le trafic doit passer par le proxy');
  const n = proxy.log.length;
  r.gw.deleteProxy(rec.id);
  r.gw.updateConnection(conn.id, { proxyId: rec.id }); // référence supprimée → ignorée à la validation
  assert.equal(r.gw.db.connections.find((c) => c.id === conn.id).proxyId, undefined);
  // proxy désactivé mais référencé : doit échouer sans sortie directe
  const rec2 = r.gw.addProxy({ name: 'p2', url: proxy.url });
  r.gw.updateConnection(conn.id, { proxyId: rec2.id });
  r.gw.updateProxy(rec2.id, { enabled: false });
  r.gw.health.reset(conn.id);
  up.calls.length = 0;
  const ko = await api('/v1/chat/completions', { method: 'POST', body: { model: 'cerebras/cerebras-model-a', messages: [{ role: 'user', content: 'encore' }] } });
  assert.notEqual(ko.status, 200);
  assert.equal(up.calls.filter((c) => c.name === 'cerebras' && c.path === '/chat/completions').length, 0, 'aucune sortie directe');
  assert.equal(proxy.log.length, n);
  r.gw.deleteConnection(conn.id); r.gw.deleteProxy(rec2.id);
  await proxy.close();
});

/* ───────── Images ───────── */

test('images : OpenAI-compatible (b64), Stability (multipart), fal.ai (file d’attente), BFL (sondage)', async () => {
  const mock = await createMockApi((c, res) => {
    if (c.url === '/oa/images/generations') return jsonRes(res, { data: [{ b64_json: PNG.toString('base64') }] });
    if (c.url.startsWith('/st/v2beta/stable-image/generate/')) return jsonRes(res, { image: PNG.toString('base64') });
    if (c.url === '/fal/fal-ai/flux/schnell') return jsonRes(res, { status_url: `${mock.base}/fal/status`, response_url: `${mock.base}/fal/result` });
    if (c.url === '/fal/status') return jsonRes(res, { status: 'COMPLETED' });
    if (c.url === '/fal/result') return jsonRes(res, { images: [{ url: 'https://cdn.example/img.png' }] });
    if (c.url === '/bfl/flux-dev') return jsonRes(res, { id: 'x', polling_url: `${mock.base}/bfl/poll` });
    if (c.url === '/bfl/poll') return jsonRes(res, { status: 'Ready', result: { sample: 'https://cdn.example/bfl.png' } });
    jsonRes(res, { error: 'inconnu' }, 404);
  });
  const ids = [
    r.gw.addConnection({ provider: 'openai', apiKey: 'sk-1', baseUrl: `${mock.base}/oa` }),
    r.gw.addConnection({ provider: 'stability', apiKey: 'sk-st', baseUrl: mock.base + '/st' }),
    r.gw.addConnection({ provider: 'fal', apiKey: 'fal-1', baseUrl: `${mock.base}/fal` }),
    r.gw.addConnection({ provider: 'bfl', apiKey: 'bfl-1', baseUrl: `${mock.base}/bfl` }),
  ];
  r.gw.updateSettings({ costMode: 'any' });
  const gen = (model) => api('/v1/images/generations', { method: 'POST', body: { model, prompt: 'un phénix', size: '1024x1024' } });
  let res = await gen('openai/gpt-image-1');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data[0].b64_json, PNG.toString('base64'));
  assert.equal(mock.calls[0].body.model, 'gpt-image-1');
  res = await gen('stability/core');
  assert.equal((await res.json()).data[0].b64_json, PNG.toString('base64'));
  assert.match(mock.calls.find((c) => c.url.startsWith('/st/')).headers['content-type'], /multipart/);
  res = await gen('fal/fal-ai/flux/schnell');
  assert.equal((await res.json()).data[0].url, 'https://cdn.example/img.png');
  res = await gen('bfl/flux-dev');
  assert.equal((await res.json()).data[0].url, 'https://cdn.example/bfl.png');
  // binaire
  const bin = await api('/v1/images/generations?response_format=binary', { method: 'POST', body: { model: 'openai/gpt-image-1', prompt: 'x' } });
  assert.equal(bin.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await bin.arrayBuffer()), PNG);
  // freeOnly : un fournisseur payant explicite est refusé
  r.gw.updateSettings({ costMode: 'freeOnly' });
  const denied = await gen('openai/gpt-image-1');
  assert.equal(denied.status, 403);
  r.gw.updateSettings({ costMode: 'freeFirst' });
  for (const c of ids) r.gw.deleteConnection(c.id);
  await mock.close();
});

test('images : prompt manquant → 400 ; aucun fournisseur → 503 explicite', async () => {
  assert.equal((await api('/v1/images/generations', { method: 'POST', body: {} })).status, 400);
  const res = await api('/v1/images/generations', { method: 'POST', body: { prompt: 'x', model: 'stability/core' } });
  assert.equal(res.status, 503);
});

/* ───────── Vidéo ───────── */

test('vidéo : fal.ai création + suivi, identifiant signé (forgé → 404), xAI en passe-plat', async () => {
  let polls = 0;
  const mock = await createMockApi((c, res) => {
    if (c.url === '/fal/fal-ai/ltx-video') return jsonRes(res, { status_url: `${mock.base}/fal/s`, response_url: `${mock.base}/fal/r` });
    if (c.url === '/fal/s') { polls += 1; return jsonRes(res, { status: polls < 2 ? 'IN_PROGRESS' : 'COMPLETED' }); }
    if (c.url === '/fal/r') return jsonRes(res, { video: { url: 'https://cdn.example/v.mp4' } });
    if (c.url === '/xai/videos/generations') return jsonRes(res, { request_id: 'abc123' });
    if (c.url === '/xai/videos/abc123') return jsonRes(res, { status: 'done', video: { url: 'https://cdn.example/x.mp4' } });
    jsonRes(res, {}, 404);
  });
  const fal = r.gw.addConnection({ provider: 'fal', apiKey: 'fal-1', baseUrl: `${mock.base}/fal` });
  r.gw.updateSettings({ costMode: 'any' });
  let res = await api('/v1/videos/generations', { method: 'POST', body: { model: 'fal/fal-ai/ltx-video', prompt: 'vague' } });
  assert.equal(res.status, 202);
  const job = await res.json();
  assert.match(job.id, /^vid_/);
  let st = await (await api(`/v1/videos/${job.id}`)).json();
  assert.equal(st.status, 'in_progress');
  st = await (await api(`/v1/videos/${job.id}`)).json();
  assert.deepEqual([st.status, st.url], ['completed', 'https://cdn.example/v.mp4']);
  // identifiant forgé : jamais suivi (pas de SSRF avec nos clés)
  const forged = `vid_${Buffer.from(JSON.stringify({ p: 'fal', c: fal.id, s: 'http://169.254.169.254/', r: 'http://169.254.169.254/' })).toString('base64url')}.${'0'.repeat(64)}`;
  assert.equal((await api(`/v1/videos/${forged}`)).status, 404);
  const xai = r.gw.addConnection({ provider: 'xai', apiKey: 'xai-1', baseUrl: mock.base + '/xai' });
  res = await api('/v1/videos/generations', { method: 'POST', body: { model: 'xai/grok-imagine-video', prompt: 'ville néon' } });
  const j2 = await res.json();
  assert.equal(mock.calls.find((c) => c.url === '/xai/videos/generations').body.model, 'grok-imagine-video');
  st = await (await api(`/v1/videos/${j2.id}`)).json();
  assert.equal(st.status, 'completed');
  r.gw.deleteConnection(fal.id); r.gw.deleteConnection(xai.id);
  await mock.close();
  r.gw.updateSettings({ costMode: 'freeFirst' });
});

/* ───────── Recherche & lecture web ───────── */

test('web : Tavily/Brave/Serper normalisés, repli entre fournisseurs, lecture Tavily/Firecrawl', async () => {
  const mock = await createMockApi((c, res) => {
    if (c.url === '/tv/search') return jsonRes(res, { results: [{ title: 'A', url: 'https://a.example/p', content: 'sa', score: 0.9 }], answer: 'rép' });
    if (c.url === '/tv/extract') return jsonRes(res, { results: [{ url: 'https://a.example/p', raw_content: 'contenu complet' }] });
    if (c.url.startsWith('/br/web/search')) return jsonRes(res, { web: { results: [{ title: 'B', url: 'https://b.example/', description: 'sb' }] } });
    if (c.url === '/sp/search') return jsonRes(res, { organic: [{ title: 'C', link: 'https://c.example/', snippet: 'sc' }] });
    if (c.url === '/fc/scrape') return jsonRes(res, { success: true, data: { markdown: '# Page', metadata: { title: 'T' } } });
    jsonRes(res, {}, 500);
  });
  const conns = [
    r.gw.addConnection({ provider: 'tavily', apiKey: 'tvly-1', baseUrl: `${mock.base}/tv` }),
    r.gw.addConnection({ provider: 'brave', apiKey: 'bk', baseUrl: `${mock.base}/br` }),
    r.gw.addConnection({ provider: 'serper', apiKey: 'sk', baseUrl: `${mock.base}/sp` }),
    r.gw.addConnection({ provider: 'firecrawl', apiKey: 'fc', baseUrl: `${mock.base}/fc` }),
  ];
  let j = await (await api('/v1/search', { method: 'POST', body: { model: 'tavily', query: 'phénix', max_results: 3 } })).json();
  assert.equal(j.provider, 'tavily');
  assert.equal(j.results[0].citation.provider, 'tavily');
  assert.equal(j.results[0].display_url, 'a.example/p');
  assert.equal(j.answer, 'rép');
  assert.equal(mock.calls[0].headers.authorization, 'Bearer tvly-1');
  j = await (await api('/v1/search', { method: 'POST', body: { provider: 'brave', query: 'x' } })).json();
  assert.equal(j.results[0].url, 'https://b.example/');
  j = await (await api('/v1/search', { method: 'POST', body: { model: 'serper/search', query: 'x' } })).json();
  assert.equal(j.results[0].snippet, 'sc');
  // auto : Tavily en panne → bascule sur le suivant
  r.gw.deleteConnection(conns[0].id);
  j = await (await api('/v1/search', { method: 'POST', body: { query: 'x' } })).json();
  assert.ok(['brave', 'serper'].includes(j.provider));
  // lecture
  j = await (await api('/v1/web/fetch', { method: 'POST', body: { model: 'firecrawl', url: 'https://a.example/', format: 'markdown' } })).json();
  assert.equal(j.data.title, 'T');
  assert.equal(j.data.content, '# Page');
  assert.equal(j.text, '# Page'); // ancien champ conservé
  // clé absente pour un fournisseur explicite
  assert.equal((await api('/v1/search', { method: 'POST', body: { model: 'exa', query: 'x' } })).status, 503);
  assert.equal((await api('/v1/search', { method: 'POST', body: { model: 'inconnu', query: 'x' } })).status, 400);
  assert.equal((await api('/v1/web/fetch', { method: 'POST', body: { url: 'ftp://x' } })).status, 400);
  for (const c of conns.slice(1)) r.gw.deleteConnection(c.id);
  await mock.close();
});

/* ───────── Gemini natif ───────── */

test('gemini : traduction requête/réponse (outils, système, images)', () => {
  const oa = geminiToOpenAI({
    systemInstruction: { parts: [{ text: 'Sois bref' }] },
    contents: [
      { role: 'user', parts: [{ text: 'Météo ?' }] },
      { role: 'model', parts: [{ functionCall: { name: 'meteo', args: { ville: 'Ouaga' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'meteo', response: { t: 35 } } }] },
    ],
    generationConfig: { temperature: 0.2, maxOutputTokens: 50, stopSequences: ['X'] },
    tools: [{ functionDeclarations: [{ name: 'meteo', description: 'd', parameters: { type: 'OBJECT', properties: { ville: { type: 'STRING' } } } }] }],
  }, 'groq/m', false);
  assert.equal(oa.messages[0].role, 'system');
  assert.equal(oa.messages[2].tool_calls[0].function.name, 'meteo');
  assert.equal(oa.messages[3].role, 'tool');
  assert.equal(oa.messages[3].tool_call_id, oa.messages[2].tool_calls[0].id);
  assert.equal(oa.tools[0].function.parameters.type, 'object');
  assert.equal(oa.tools[0].function.parameters.properties.ville.type, 'string');
  assert.equal(oa.max_tokens, 50);
  const g = openAIToGemini({ id: 'x', model: 'm', choices: [{ message: { content: null, tool_calls: [{ function: { name: 'meteo', arguments: '{"ville":"Ouaga"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 4 } }, 'm');
  assert.deepEqual(g.candidates[0].content.parts[0].functionCall, { name: 'meteo', args: { ville: 'Ouaga' } });
  assert.equal(g.usageMetadata.totalTokenCount, 7);
});

test('gemini : /v1beta generateContent, streamGenerateContent, models, embedContent, auth ?key=', async () => {
  const body = { contents: [{ role: 'user', parts: [{ text: 'Salut' }] }] };
  const url = (suffix, key = r.apiKey) => `${r.app.url}/v1beta/models/${suffix}${key ? `${suffix.includes('?') ? '&' : '?'}key=${key}` : ''}`;
  let res = await fetch(url('groq%2Fgroq-model-a:generateContent'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.candidates[0].content.parts[0].text, 'hello from groq');
  assert.equal(j.candidates[0].finishReason, 'STOP');
  res = await fetch(`${r.app.url}/v1beta/models/groq%2Fgroq-model-a:streamGenerateContent?alt=sse`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': r.apiKey }, body: JSON.stringify(body) });
  const text = await res.text();
  const events = text.split('\n\n').filter(Boolean).map((b) => JSON.parse(b.replace(/^data: /, '')));
  assert.equal(events.map((e) => e.candidates[0].content.parts[0].text).join(''), 'hello from groq');
  assert.equal(events.at(-1).candidates[0].finishReason, 'STOP');
  assert.ok(events.at(-1).usageMetadata.totalTokenCount > 0);
  res = await fetch(`${r.app.url}/v1beta/models`, { headers: { 'x-goog-api-key': r.apiKey } });
  assert.ok((await res.json()).models.some((m) => m.name === 'models/groq/groq-model-a'));
  // sans clé → 401 au format Google
  res = await fetch(`${r.app.url}/v1beta/models`);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.status, 'UNAUTHENTICATED');
  // embeddings (mock : un vecteur)
  res = await fetch(url('groq%2Fgroq-model-a:embedContent'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: { parts: [{ text: 'bonjour' }] } }) });
  assert.deepEqual((await res.json()).embedding.values, [0.1, 0.2, 0.3]);
  assert.equal((await fetch(url('groq%2Fgroq-model-a:countTokens'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json())).totalTokens > 0, true);
});

/* ───────── Audio natif, catalogues par type ───────── */

test('audio : multipart parsé, Deepgram STT, ElevenLabs TTS (+ ?response_format=json), voix', async () => {
  const mock = await createMockApi((c, res) => {
    if (c.url.startsWith('/dg/listen')) return jsonRes(res, { results: { channels: [{ alternatives: [{ transcript: 'bonjour le monde' }] }] } });
    if (c.url.startsWith('/el/text-to-speech/')) { res.writeHead(200, { 'content-type': 'audio/mpeg' }); res.end(Buffer.from('ID3fake')); return; }
    if (c.url === '/el/voices') return jsonRes(res, { voices: [{ voice_id: 'v1', name: 'Rachel', category: 'premade' }] });
    jsonRes(res, {}, 404);
  });
  const dg = r.gw.addConnection({ provider: 'deepgram', apiKey: 'dg-1', baseUrl: `${mock.base}/dg` });
  const el = r.gw.addConnection({ provider: 'elevenlabs', apiKey: 'el-1', baseUrl: `${mock.base}/el` });
  const form = new FormData();
  form.set('model', 'deepgram/nova-3'); form.set('language', 'fr');
  form.set('file', new Blob([Buffer.from('RIFFxxxxWAVE')], { type: 'audio/wav' }), 'a.wav');
  const stt = await fetch(`${r.app.url}/v1/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${r.apiKey}` }, body: form });
  assert.equal(stt.status, 200);
  assert.equal((await stt.json()).text, 'bonjour le monde');
  const dgCall = mock.calls.find((c) => c.url.startsWith('/dg/listen'));
  assert.match(dgCall.url, /model=nova-3/);
  assert.match(dgCall.url, /language=fr/);
  assert.equal(dgCall.headers.authorization, 'Token dg-1');
  assert.equal(dgCall.raw.toString(), 'RIFFxxxxWAVE');
  const tts = await api('/v1/audio/speech', { method: 'POST', body: { model: 'el/v1', input: 'Bonjour' } });
  assert.equal(tts.headers.get('content-type'), 'audio/mpeg');
  assert.equal(Buffer.from(await tts.arrayBuffer()).toString(), 'ID3fake');
  assert.equal(mock.calls.find((c) => c.url.startsWith('/el/text-to-speech/v1')).headers['xi-api-key'], 'el-1');
  const asJson = await (await api('/v1/audio/speech?response_format=json', { method: 'POST', body: { model: 'elevenlabs/v1', input: 'x' } })).json();
  assert.equal(asJson.format, 'mp3');
  assert.equal(Buffer.from(asJson.audio, 'base64').toString(), 'ID3fake');
  const voices = await (await api('/v1/audio/voices?provider=elevenlabs')).json();
  assert.equal(voices.data[0].model, 'el/v1');
  const mp = parseMultipart(Buffer.from('--B\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--B\r\nContent-Disposition: form-data; name="file"; filename="x.bin"\r\nContent-Type: audio/x\r\n\r\nDATA\r\n--B--\r\n'), 'multipart/form-data; boundary=B');
  assert.equal(mp.fields.a, '1');
  assert.equal(mp.file.data.toString(), 'DATA');
  r.gw.deleteConnection(dg.id); r.gw.deleteConnection(el.id);
  await mock.close();
});

test('catalogues par type, /v1/models/info, /api/health', async () => {
  const web = await (await api('/v1/models/web')).json();
  const ids = web.data.map((m) => m.id);
  assert.ok(ids.includes('search-combo') && ids.includes('direct/fetch') && ids.includes('duckduckgo/search'));
  assert.ok(web.data.find((m) => m.id === 'direct/fetch').kind === 'webFetch');
  const allImg = await (await api('/v1/models/image?all=1')).json();
  assert.ok(allImg.data.some((m) => m.id.startsWith('stability/')) && allImg.data.some((m) => m.id.startsWith('pollinations/')));
  const info = await (await api('/v1/models/info?id=stability/core')).json();
  assert.equal(info.kind, 'image');
  assert.ok(info.params.prompt);
  assert.equal((await api('/v1/models/info?id=nope')).status, 404);
  const chat = await (await api('/v1/models/chat')).json();
  assert.ok(chat.data.some((m) => m.id === 'groq/groq-model-a'));
  const h = await fetch(`${r.app.url}/api/health`);
  assert.equal((await h.json()).ok, true);
});

/* ───────── MCP ───────── */

test('mcp : initialize, tools/list, tools/call (chat), auth, notification, outil inconnu', async () => {
  const rpc = (msg, key = r.apiKey) => fetch(`${r.app.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(msg) });
  let res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal((await res.json()).result.serverInfo.name, 'phenixrouter');
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const list = (await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()).result.tools;
  assert.ok(list.some((t) => t.name === 'phenix_search'));
  const call = (await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'phenix_chat', arguments: { prompt: 'Salut', model: 'groq/groq-model-a' } } })).json()).result;
  assert.match(call.content[0].text, /hello from groq/);
  const bad = (await (await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'phenix_chat', arguments: {} } })).json()).result;
  assert.equal(bad.isError, true);
  assert.equal((await (await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'rm_rf' } })).json()).error.code, -32602);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 6, method: 'ping' }, null)).status, 401);
  assert.equal((await fetch(`${r.app.url}/mcp`, { headers: { authorization: `Bearer ${r.apiKey}` } })).status, 405);
});

/* ───────── Outils clients ───────── */

test('outils clients : écriture non destructive, sauvegarde, retrait, JSON invalide intact', () => {
  const home = mkdtempSync(join(tmpdir(), 'phx-home-'));
  const base = 'http://127.0.0.1:20128';
  // fichier existant avec autres réglages
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ theme: 'x', provider: { autre: { npm: 'y' } } }));
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "o3"\n[projects."/x"]\ntrust = "trusted"\n');
  for (const id of Object.keys(TOOLS)) {
    const out = applyTool(id, { base, key: 'phx-abc', home, platform: 'linux' });
    assert.ok(existsSync(out.file), id);
  }
  const oc = JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
  assert.equal(oc.theme, 'x');
  assert.ok(oc.provider.autre && oc.provider.phenix.options.apiKey === 'phx-abc');
  assert.equal(oc.provider.phenix.options.baseURL, `${base}/v1`);
  assert.ok(existsSync(join(home, '.config', 'opencode', 'opencode.json.bak')));
  const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
  assert.ok(toml.startsWith('model = "o3"') && toml.includes('[profiles.phenix]'));
  applyTool('codex', { base, key: 'phx-abc', home, platform: 'linux' }); // idempotent
  assert.equal(readFileSync(join(home, '.codex', 'config.toml'), 'utf8').split('[profiles.phenix]').length, 2);
  const claude = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(claude.env.ANTHROPIC_BASE_URL, base);
  const cline = JSON.parse(readFileSync(join(home, '.cline', 'data', 'globalState.json'), 'utf8'));
  assert.equal(cline.openAiBaseUrl, base);
  for (const id of Object.keys(TOOLS)) assert.equal(removeTool(id, { home, platform: 'linux' }).removed, true, id);
  assert.ok(!readFileSync(join(home, '.codex', 'config.toml'), 'utf8').includes('phenix'));
  assert.ok(JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8')).provider.autre);
  // JSON invalide : refus sans rien écraser
  writeFileSync(join(home, '.claude', 'settings.json'), '{ pas du json');
  assert.throws(() => applyTool('claude', { base, key: 'k', home, platform: 'linux' }), /JSON valide/);
  assert.equal(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'), '{ pas du json');
  assert.throws(() => applyTool('claude', { base, key: '', home }), /Clé/);
  rmSync(home, { recursive: true, force: true });
});

test('API admin : outils clients (clé dédiée) et proxys exigent une session', async () => {
  const noAuth = await fetch(`${r.app.url}/api/clitools`);
  assert.equal(noAuth.status, 401);
  const login = await fetch(`${r.app.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: r.app.url }, body: JSON.stringify({ password: process.env.PHENIX_PASSWORD ?? 'x' }) });
  assert.ok([200, 401].includes(login.status));
  r.gw.setPassword('motdepasse-test');
  const ok = await fetch(`${r.app.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: r.app.url }, body: JSON.stringify({ password: 'motdepasse-test' }) });
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  const get = (p, init = {}) => fetch(`${r.app.url}${p}`, { ...init, headers: { cookie, origin: r.app.url, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const info = await (await get('/api/clitools')).json();
  assert.ok(info.tools.some((t) => t.id === 'opencode') && info.manual.aider);
  const bad = await get('/api/proxies', { method: 'POST', body: JSON.stringify({ name: 'x', url: 'socks5://h:1' }) });
  assert.equal(bad.status, 400);
  const p = await (await get('/api/proxies', { method: 'POST', body: JSON.stringify({ name: 'ok', url: 'http://u:pw@127.0.0.1:9' }) })).json();
  assert.ok(!JSON.stringify(p).includes('pw'));
  const t = await (await get(`/api/proxies/${p.proxy.id}/test`, { method: 'POST' })).json();
  assert.equal(t.ok, false); // port 9 fermé
  assert.equal((await get(`/api/proxies/${p.proxy.id}`, { method: 'DELETE' })).status, 200);
  const providers = await (await get('/api/providers')).json();
  const stab = providers.providers.find((x) => x.id === 'stability');
  assert.deepEqual([stab.mediaOnly, stab.caps], [true, ['image']]);
  assert.ok(providers.providers.find((x) => x.id === 'tavily').caps.includes('search'));
});

/* ───────── Tunnel ───────── */

test('tunnel : cloudflared simulé (URL détectée), refus sans clé API via l’API, arrêt propre', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-tun-'));
  const fake = join(dir, 'cloudflared');
  writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "cloudflared version 0"; exit 0; fi\necho "INF |  https://fake-demo-123.trycloudflare.com  |" >&2\nexec sleep 30\n');
  chmodSync(fake, 0o755);
  process.env.PHENIX_CLOUDFLARED = fake;
  try {
    const tun = new Tunnel();
    assert.equal(tun.status().available.cloudflared, true);
    const st = await tun.start('cloudflared', 20128, { timeoutMs: 5000 });
    assert.equal(st.url, 'https://fake-demo-123.trycloudflare.com');
    await assert.rejects(() => tun.start('cloudflared', 1), /déjà actif/);
    tun.stop();
    assert.equal(tun.status().status, 'stopped');
    await assert.rejects(() => tun.start('ngrok', 1), /inconnu/);
    process.env.PHENIX_CLOUDFLARED = join(dir, 'absent');
    await assert.rejects(() => new Tunnel().start('cloudflared', 1), /introuvable/);
  } finally { delete process.env.PHENIX_CLOUDFLARED; rmSync(dir, { recursive: true, force: true }); }
});
