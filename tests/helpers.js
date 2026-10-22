// Copyright (c) 2026 Fido-labs —kcw—
// Outils de test : faux fournisseur amont compatible OpenAI + instance PhenixRouter isolée.
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/server.js';

/** Faux amont. behavior[name] ∈ ok | 429 | 500 | err200 | empty | 401 | 400tools */
export async function createMockUpstream() {
  const behavior = {};
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const m = /^\/([^/]+)\/v1(\/.*)$/.exec(req.url);
    if (!m) { res.writeHead(404); res.end('{}'); return; }
    const [, name, path] = m;
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ name, path, body, auth: req.headers.authorization });
    const mode = behavior[name] ?? 'ok';
    const json = (status, obj, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(obj));
    };

    if (path === '/models') {
      json(200, { data: [{ id: `${name}-model-a` }, { id: `${name}-model-b` }, { id: 'whisper-large' }] });
      return;
    }
    if (mode === '429') return json(429, { error: { message: 'Rate limit reached, please try again in 2s' } }, { 'retry-after': '2' });
    if (mode === '500') return json(500, { error: { message: 'boom' } });
    if (mode === '401') return json(401, { error: { message: 'bad key' } });
    if (mode === '400tools' && body.tools) return json(400, { error: { message: 'tools are not supported by this model' } });
    if (mode === 'err200') return json(200, { error: { message: 'upstream exploded' } });

    if (path === '/embeddings') {
      return json(200, { object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }], model: body.model, usage: { prompt_tokens: 3, total_tokens: 3 } });
    }

    const tool = !!body.tools?.length && body.tool_choice === 'required';
    if (body.stream) {
      if (mode === 'empty') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: [DONE]\n\n'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const base = { id: 'chatcmpl-x', object: 'chat.completion.chunk', model: body.model };
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
      if (tool) {
        send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city"' } }] } }] });
        send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"Paris"}' } }] } }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        send({ ...base, choices: [{ index: 0, delta: { content: `hello from ` } }] });
        send({ ...base, choices: [{ index: 0, delta: { content: name } }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }
      send({ ...base, choices: [], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } });
      res.end('data: [DONE]\n\n');
      return;
    }
    const message = tool
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] }
      : { role: 'assistant', content: `hello from ${name}` };
    json(200, {
      id: 'chatcmpl-x', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, behavior, calls,
    url: (name) => `${base}/${name}/v1`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

/** Instance PhenixRouter isolée (dossier temporaire, aucun accès réseau implicite). */
export async function createRouter({ requireApiKey = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'phx-test-'));
  const app = await start({ port: 0, host: '127.0.0.1', dataDir: dir });
  const { gw } = app;
  for (const id of ['auto:pollinations', 'auto:ollama', 'auto:lmstudio']) gw.updateConnection(id, { enabled: false });
  gw.updateSettings({ requireApiKey });
  const apiKey = gw.createApiKey('test').key;
  const api = async (path, { method = 'GET', body, headers = {}, key = apiKey } = {}) => {
    const res = await fetch(`${app.url}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  };
  return {
    app, gw, dir, apiKey, api,
    close: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

export async function readSse(res) {
  const text = await res.text();
  return text.split(/\n\n/).filter(Boolean).map((block) => {
    const ev = { event: null, data: null };
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) ev.event = line.slice(6).trim();
      else if (line.startsWith('data:')) ev.data = line.slice(5).trim();
    }
    return ev;
  });
}
