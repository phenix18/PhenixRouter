// Copyright (c) 2026 Fido-labs —kcw—
// Traducteur Anthropic Messages API  ⇄  OpenAI Chat Completions.
// Permet à Claude Code & co. d'utiliser n'importe quel modèle gratuit du routeur.
import { randomUUID } from 'node:crypto';
import { sseEvent } from '../sse.js';

export const genId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

export function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p?.type === 'text' || p?.type === 'output_text' || p?.type === 'input_text' ? p.text ?? '' : ''))
      .join('');
  }
  return '';
}

function flattenSystem(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).filter(Boolean).join('\n\n');
  return '';
}

function toolResultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : JSON.stringify(b))).join('\n');
  }
  return JSON.stringify(content);
}

function imageUrl(source) {
  if (!source) return '';
  if (source.type === 'base64') return `data:${source.media_type ?? 'image/png'};base64,${source.data}`;
  return source.url ?? '';
}

export function mapToolChoice(tc) {
  if (!tc) return undefined;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'none') return 'none';
  if (tc.type === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } };
  return undefined;
}

/** Requête Anthropic → requête OpenAI. */
export function anthropicToOpenAI(body) {
  const out = { model: body.model, messages: [], stream: !!body.stream };
  const system = flattenSystem(body.system);
  if (system) out.messages.push({ role: 'system', content: system });

  for (const m of body.messages ?? []) {
    if (typeof m.content === 'string') {
      out.messages.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'assistant') {
      const texts = [];
      const toolCalls = [];
      for (const b of blocks) {
        if (b.type === 'text') texts.push(b.text);
        else if (b.type === 'tool_use') {
          toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
        }
        // thinking / redacted_thinking : ignorés (non transférables)
      }
      const msg = { role: 'assistant', content: texts.join('\n') || (toolCalls.length ? null : '') };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.messages.push(msg);
    } else {
      const parts = [];
      const tools = [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          const text = toolResultText(b.content);
          tools.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `[error] ${text}` : text });
        } else if (b.type === 'text') {
          parts.push({ type: 'text', text: b.text });
        } else if (b.type === 'image') {
          parts.push({ type: 'image_url', image_url: { url: imageUrl(b.source) } });
        }
      }
      out.messages.push(...tools); // les résultats d'outils doivent suivre immédiatement l'appel
      if (parts.length) {
        out.messages.push({
          role: 'user',
          content: parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('\n') : parts,
        });
      }
    }
  }

  if (body.max_tokens != null) out.max_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop_sequences?.length) out.stop = body.stop_sequences;
  if (body.tools?.length) {
    out.tools = body.tools
      .filter((t) => t.name && !t.type?.startsWith?.('web_search') && !t.type?.startsWith?.('computer'))
      .map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object', properties: {} } } }));
    if (!out.tools.length) delete out.tools;
  }
  const tc = mapToolChoice(body.tool_choice);
  if (tc && out.tools) out.tool_choice = tc;
  if (out.stream) out.stream_options = { include_usage: true };
  return out;
}

const FINISH = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'end_turn' };
export const mapFinish = (r) => FINISH[r] ?? 'end_turn';

export function safeJson(text) {
  if (text && typeof text === 'object') return text;
  try { return JSON.parse(text || '{}'); } catch { return { _raw: String(text ?? '') }; }
}

/** Réponse OpenAI → réponse Anthropic. */
export function openAIToAnthropic(resp, model) {
  const choice = resp.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content = [];
  const text = contentToText(msg.content);
  if (text) content.push({ type: 'text', text });
  for (const tc of msg.tool_calls ?? []) {
    content.push({ type: 'tool_use', id: tc.id || genId('toolu'), name: tc.function?.name ?? '', input: safeJson(tc.function?.arguments) });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  return {
    id: genId('msg'),
    type: 'message',
    role: 'assistant',
    model: model ?? resp.model,
    content,
    stop_reason: msg.tool_calls?.length ? 'tool_use' : mapFinish(choice.finish_reason),
    stop_sequence: null,
    usage: { input_tokens: resp.usage?.prompt_tokens ?? 0, output_tokens: resp.usage?.completion_tokens ?? 0 },
  };
}

/**
 * Machine à états : chunks OpenAI → événements SSE Anthropic.
 * Le texte est diffusé en direct ; les appels d'outils sont mis en tampon puis émis
 * en blocs complets (robuste face aux fournisseurs qui entrelacent les appels).
 */
export class AnthropicStream {
  constructor(model, inputTokens = 0) {
    this.model = model;
    this.id = genId('msg');
    this.inputTokens = inputTokens;
    this.outputTokens = 0;
    this.index = -1;
    this.textOpen = false;
    this.tools = new Map();
    this.finish = null;
    this.started = false;
    this.hadBlock = false;
  }

  start() {
    this.started = true;
    return [
      sseEvent('message_start', {
        type: 'message_start',
        message: {
          id: this.id, type: 'message', role: 'assistant', model: this.model, content: [],
          stop_reason: null, stop_sequence: null, usage: { input_tokens: this.inputTokens, output_tokens: 0 },
        },
      }),
      sseEvent('ping', { type: 'ping' }),
    ];
  }

  push(chunk) {
    const out = [];
    if (chunk.usage) {
      if (chunk.usage.prompt_tokens != null) this.inputTokens = chunk.usage.prompt_tokens;
      if (chunk.usage.completion_tokens != null) this.outputTokens = chunk.usage.completion_tokens;
    }
    const choice = chunk.choices?.[0];
    if (!choice) return out;
    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string' && delta.content.length) {
      if (!this.textOpen) {
        this.index += 1;
        this.textOpen = true;
        this.hadBlock = true;
        out.push(sseEvent('content_block_start', { type: 'content_block_start', index: this.index, content_block: { type: 'text', text: '' } }));
      }
      out.push(sseEvent('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'text_delta', text: delta.content } }));
    }
    for (const tc of delta.tool_calls ?? []) {
      const i = tc.index ?? 0;
      const t = this.tools.get(i) ?? { id: '', name: '', args: '' };
      if (tc.id) t.id = tc.id;
      if (tc.function?.name) t.name += tc.function.name;
      if (tc.function?.arguments) t.args += tc.function.arguments;
      this.tools.set(i, t);
    }
    if (choice.finish_reason) this.finish = choice.finish_reason;
    return out;
  }

  _closeText(out) {
    if (this.textOpen) {
      out.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: this.index }));
      this.textOpen = false;
    }
  }

  end(estimatedOutputTokens = 0) {
    const out = [];
    this._closeText(out);
    const ordered = [...this.tools.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, t] of ordered) {
      this.index += 1;
      this.hadBlock = true;
      out.push(sseEvent('content_block_start', {
        type: 'content_block_start', index: this.index,
        content_block: { type: 'tool_use', id: t.id || genId('toolu'), name: t.name, input: {} },
      }));
      out.push(sseEvent('content_block_delta', {
        type: 'content_block_delta', index: this.index, delta: { type: 'input_json_delta', partial_json: t.args || '{}' },
      }));
      out.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: this.index }));
    }
    if (!this.hadBlock) {
      this.index += 1;
      out.push(sseEvent('content_block_start', { type: 'content_block_start', index: this.index, content_block: { type: 'text', text: '' } }));
      out.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: this.index }));
    }
    const stop = ordered.length ? 'tool_use' : mapFinish(this.finish);
    out.push(sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: this.outputTokens || estimatedOutputTokens },
    }));
    out.push(sseEvent('message_stop', { type: 'message_stop' }));
    return out;
  }
}

export function anthropicError(type, message) {
  return { type: 'error', error: { type, message } };
}

export const ANTHROPIC_ERROR_TYPES = {
  400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error',
  404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error',
  500: 'api_error', 502: 'api_error', 503: 'overloaded_error', 529: 'overloaded_error',
};
