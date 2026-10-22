// Copyright (c) 2026 Fido-labs —kcw—
// Traducteur OpenAI Responses API (Codex & co.)  ⇄  Chat Completions.
import { genId, contentToText, safeJson } from './anthropic.js';
import { sseEvent } from '../sse.js';

function partToChat(p) {
  if (typeof p === 'string') return { type: 'text', text: p };
  if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') return { type: 'text', text: p.text ?? '' };
  if (p.type === 'input_image') {
    const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
    return url ? { type: 'image_url', image_url: { url } } : null;
  }
  return null;
}

function mapResponsesToolChoice(tc) {
  if (!tc) return undefined;
  if (typeof tc === 'string') return tc; // auto | none | required
  if (tc.type === 'function' && tc.name) return { type: 'function', function: { name: tc.name } };
  return undefined;
}

/** Requête Responses → requête Chat Completions. */
export function responsesToChat(body) {
  const out = { model: body.model, messages: [], stream: !!body.stream };
  if (body.instructions) out.messages.push({ role: 'system', content: String(body.instructions) });

  const input = body.input;
  if (typeof input === 'string') {
    out.messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    let pendingCalls = null;
    const flush = () => { pendingCalls = null; };
    for (const item of input) {
      if (item.type === 'function_call') {
        if (!pendingCalls) {
          pendingCalls = { role: 'assistant', content: null, tool_calls: [] };
          out.messages.push(pendingCalls);
        }
        pendingCalls.tool_calls.push({ id: item.call_id ?? item.id, type: 'function', function: { name: item.name, arguments: item.arguments ?? '{}' } });
        continue;
      }
      flush();
      if (item.type === 'function_call_output') {
        out.messages.push({ role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output) });
      } else if (item.type === 'message' || item.role) {
        const role = item.role === 'developer' ? 'system' : item.role ?? 'user';
        if (typeof item.content === 'string') {
          out.messages.push({ role, content: item.content });
        } else {
          const parts = (item.content ?? []).map(partToChat).filter(Boolean);
          out.messages.push({ role, content: parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('') : parts });
        }
      }
      // reasoning, item_reference… : ignorés
    }
  }

  if (body.max_output_tokens != null) out.max_tokens = body.max_output_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  const tools = (body.tools ?? [])
    .filter((t) => t.type === 'function' && t.name)
    .map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.parameters ?? { type: 'object', properties: {} } } }));
  if (tools.length) {
    out.tools = tools;
    const tc = mapResponsesToolChoice(body.tool_choice);
    if (tc) out.tool_choice = tc;
  }
  if (body.text?.format?.type === 'json_object') out.response_format = { type: 'json_object' };
  if (out.stream) out.stream_options = { include_usage: true };
  return out;
}

function usageOf(u = {}) {
  const i = u.prompt_tokens ?? 0;
  const o = u.completion_tokens ?? 0;
  return { input_tokens: i, output_tokens: o, total_tokens: i + o };
}

/** Réponse Chat Completions → objet Response. */
export function chatToResponses(resp, model, reqBody = {}) {
  const msg = resp.choices?.[0]?.message ?? {};
  const output = [];
  const text = contentToText(msg.content);
  if (text || !msg.tool_calls?.length) {
    output.push({
      type: 'message', id: genId('msg'), status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }
  for (const tc of msg.tool_calls ?? []) {
    output.push({
      type: 'function_call', id: genId('fc'), call_id: tc.id || genId('call'), name: tc.function?.name ?? '',
      arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(safeJson(tc.function?.arguments)),
      status: 'completed',
    });
  }
  return {
    id: genId('resp'), object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed',
    model, output, usage: usageOf(resp.usage),
    instructions: reqBody.instructions ?? null, parallel_tool_calls: true, tool_choice: reqBody.tool_choice ?? 'auto', tools: reqBody.tools ?? [],
  };
}

/** Chunks Chat Completions → événements SSE Responses. */
export class ResponsesStream {
  constructor(model, reqBody = {}) {
    this.model = model;
    this.reqBody = reqBody;
    this.id = genId('resp');
    this.msgId = genId('msg');
    this.seq = 0;
    this.text = '';
    this.textStarted = false;
    this.tools = new Map();
    this.usage = {};
    this.createdAt = Math.floor(Date.now() / 1000);
  }

  _ev(type, data) {
    return sseEvent(type, { type, sequence_number: this.seq++, ...data });
  }

  _base(status, output = []) {
    return {
      id: this.id, object: 'response', created_at: this.createdAt, status, model: this.model, output,
      instructions: this.reqBody.instructions ?? null, tools: this.reqBody.tools ?? [],
    };
  }

  start() {
    return [this._ev('response.created', { response: this._base('in_progress') }), this._ev('response.in_progress', { response: this._base('in_progress') })];
  }

  push(chunk) {
    const out = [];
    if (chunk.usage) this.usage = chunk.usage;
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return out;
    if (typeof delta.content === 'string' && delta.content.length) {
      if (!this.textStarted) {
        this.textStarted = true;
        out.push(this._ev('response.output_item.added', {
          output_index: 0, item: { type: 'message', id: this.msgId, status: 'in_progress', role: 'assistant', content: [] },
        }));
        out.push(this._ev('response.content_part.added', {
          item_id: this.msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] },
        }));
      }
      this.text += delta.content;
      out.push(this._ev('response.output_text.delta', { item_id: this.msgId, output_index: 0, content_index: 0, delta: delta.content }));
    }
    for (const tc of delta.tool_calls ?? []) {
      const i = tc.index ?? 0;
      const t = this.tools.get(i) ?? { id: '', name: '', args: '' };
      if (tc.id) t.id = tc.id;
      if (tc.function?.name) t.name += tc.function.name;
      if (tc.function?.arguments) t.args += tc.function.arguments;
      this.tools.set(i, t);
    }
    return out;
  }

  end() {
    const out = [];
    const output = [];
    let outputIndex = 0;
    if (this.textStarted) {
      const part = { type: 'output_text', text: this.text, annotations: [] };
      out.push(this._ev('response.output_text.done', { item_id: this.msgId, output_index: 0, content_index: 0, text: this.text }));
      out.push(this._ev('response.content_part.done', { item_id: this.msgId, output_index: 0, content_index: 0, part }));
      const item = { type: 'message', id: this.msgId, status: 'completed', role: 'assistant', content: [part] };
      out.push(this._ev('response.output_item.done', { output_index: 0, item }));
      output.push(item);
      outputIndex = 1;
    }
    for (const [, t] of [...this.tools.entries()].sort((a, b) => a[0] - b[0])) {
      const id = genId('fc');
      const callId = t.id || genId('call');
      const args = t.args || '{}';
      out.push(this._ev('response.output_item.added', {
        output_index: outputIndex, item: { type: 'function_call', id, call_id: callId, name: t.name, arguments: '', status: 'in_progress' },
      }));
      out.push(this._ev('response.function_call_arguments.delta', { item_id: id, output_index: outputIndex, delta: args }));
      out.push(this._ev('response.function_call_arguments.done', { item_id: id, output_index: outputIndex, arguments: args }));
      const item = { type: 'function_call', id, call_id: callId, name: t.name, arguments: args, status: 'completed' };
      out.push(this._ev('response.output_item.done', { output_index: outputIndex, item }));
      output.push(item);
      outputIndex += 1;
    }
    if (!output.length) {
      const item = { type: 'message', id: this.msgId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }] };
      out.push(this._ev('response.output_item.done', { output_index: 0, item }));
      output.push(item);
    }
    out.push(this._ev('response.completed', { response: { ...this._base('completed', output), usage: usageOf(this.usage) } }));
    return out;
  }
}
