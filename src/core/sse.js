// Copyright (c) 2026 Fido-labs —kcw—
// Lecture/écriture SSE (Server-Sent Events).

export class StreamError extends Error {
  constructor(message, kind = 'server') {
    super(message);
    this.name = 'StreamError';
    this.kind = kind;
  }
}

function withTimeout(promise, ms, label) {
  if (!ms) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new StreamError(label, 'network')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function parseBlock(raw) {
  let event = null;
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i === -1 ? line : line.slice(0, i);
    const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length || event ? { event, data: data.join('\n') } : null;
}

/** Itère les événements SSE d'un flux web. */
export async function* sseEvents(body, { idleMs = 60000 } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const chunk = await withTimeout(reader.read(), idleMs, 'délai d’inactivité du flux dépassé');
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const m = /\r?\n\r?\n/.exec(buf);
        if (!m) break;
        const raw = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const ev = parseBlock(raw);
        if (ev) yield ev;
      }
    }
    buf += decoder.decode();
    if (buf.trim()) {
      const ev = parseBlock(buf);
      if (ev) yield ev;
    }
  } finally {
    try { await reader.cancel(); } catch { /* flux déjà fermé */ }
  }
}

export const DONE = Symbol('done');

/** Itère les chunks JSON d'un flux "chat.completions" ; émet DONE pour [DONE]. */
export async function* openaiChunks(body, opts) {
  for await (const ev of sseEvents(body, opts)) {
    const data = ev.data.trim();
    if (!data) continue;
    if (data === '[DONE]') { yield DONE; return; }
    let json;
    try { json = JSON.parse(data); } catch { continue; }
    if (json?.error && !json.choices) {
      throw new StreamError(json.error.message ?? JSON.stringify(json.error), 'server');
    }
    yield json;
  }
}

export function sseHeaders(extra = {}) {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...extra,
  };
}

export const sseData = (obj) => `data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`;
export const sseEvent = (event, obj) => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
