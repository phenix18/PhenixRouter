// Copyright (c) 2026 Fido-labs —kcw—
// Traducteur API Gemini native (generateContent / streamGenerateContent)  ⇄  OpenAI Chat Completions.
// Permet d'utiliser le routeur depuis les SDK Google (@google/genai, gemini-cli, etc.).
import { randomUUID } from 'node:crypto';
import { sseData } from '../sse.js';

const FINISH = { stop: 'STOP', length: 'MAX_TOKENS', content_filter: 'SAFETY', tool_calls: 'STOP' };
const argsOf = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

/** Requête Gemini → requête OpenAI. `model` vient de l'URL. */
export function geminiToOpenAI(body, model, stream) {
  const out = { model, messages: [], stream: !!stream };
  const sys = body.systemInstruction ?? body.system_instruction;
  const sysText = (sys?.parts ?? []).map((p) => p.text ?? '').join('\n').trim();
  if (sysText) out.messages.push({ role: 'system', content: sysText });
  let n = 0;
  const pendingCalls = []; // ids des appels d'outil non encore répondus (appariement par ordre/nom)
  for (const c of body.contents ?? []) {
    const parts = c.parts ?? [];
    if (c.role === 'model') {
      const text = parts.map((p) => p.text ?? '').join('');
      const calls = parts.filter((p) => p.functionCall).map((p) => {
        n += 1;
        const id = `call_${n}`;
        pendingCalls.push({ id, name: p.functionCall.name });
        return { id, type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) } };
      });
      out.messages.push({ role: 'assistant', content: text || (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    const responses = parts.filter((p) => p.functionResponse);
    for (const r of responses) {
      const idx = pendingCalls.findIndex((x) => x.name === r.functionResponse.name);
      const id = idx >= 0 ? pendingCalls.splice(idx, 1)[0].id : `call_${(n += 1)}`;
      out.messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(r.functionResponse.response ?? {}) });
    }
    const content = parts.filter((p) => p.text != null || p.inlineData || p.inline_data || p.fileData).map((p) => {
      if (p.text != null) return { type: 'text', text: p.text };
      const d = p.inlineData ?? p.inline_data;
      if (d) return { type: 'image_url', image_url: { url: `data:${d.mimeType ?? d.mime_type ?? 'image/png'};base64,${d.data}` } };
      return { type: 'image_url', image_url: { url: p.fileData.fileUri } };
    });
    if (content.length) out.messages.push({ role: 'user', content: content.every((x) => x.type === 'text') ? content.map((x) => x.text).join('') : content });
  }
  const g = body.generationConfig ?? body.generation_config ?? {};
  if (g.temperature != null) out.temperature = g.temperature;
  if (g.topP != null) out.top_p = g.topP;
  if (g.maxOutputTokens != null) out.max_tokens = g.maxOutputTokens;
  if (g.stopSequences?.length) out.stop = g.stopSequences;
  if (g.candidateCount > 1) out.n = Math.min(g.candidateCount, 4);
  if (g.responseMimeType === 'application/json') out.response_format = { type: 'json_object' };
  const decls = (body.tools ?? []).flatMap((t) => t.functionDeclarations ?? t.function_declarations ?? []);
  if (decls.length) {
    out.tools = decls.map((d) => ({ type: 'function', function: { name: d.name, description: d.description ?? '', parameters: normSchema(d.parameters ?? { type: 'object', properties: {} }) } }));
    const mode = (body.toolConfig ?? body.tool_config)?.functionCallingConfig?.mode;
    if (mode === 'ANY') out.tool_choice = 'required';
    else if (mode === 'NONE') out.tool_choice = 'none';
  }
  return out;
}

/** Schéma Gemini (types en MAJUSCULES) → JSON Schema. */
function normSchema(s) {
  if (Array.isArray(s)) return s.map(normSchema);
  if (!s || typeof s !== 'object') return s;
  const o = {};
  for (const [k, v] of Object.entries(s)) o[k] = k === 'type' && typeof v === 'string' ? v.toLowerCase() : normSchema(v);
  return o;
}

const usage = (u) => (u ? { promptTokenCount: u.prompt_tokens ?? 0, candidatesTokenCount: u.completion_tokens ?? 0, totalTokenCount: u.total_tokens ?? ((u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)) } : undefined);

/** Réponse OpenAI → réponse Gemini. */
export function openAIToGemini(json, model) {
  return {
    candidates: (json.choices ?? []).map((c, i) => {
      const parts = [];
      if (c.message?.content) parts.push({ text: String(c.message.content) });
      for (const tc of c.message?.tool_calls ?? []) parts.push({ functionCall: { name: tc.function?.name, args: argsOf(tc.function?.arguments) } });
      if (!parts.length) parts.push({ text: '' });
      return { content: { role: 'model', parts }, finishReason: FINISH[c.finish_reason] ?? 'STOP', index: i };
    }),
    usageMetadata: usage(json.usage),
    modelVersion: json.model ?? model,
    responseId: json.id ?? `resp_${randomUUID().slice(0, 12)}`,
  };
}

/** Flux de chunks OpenAI → flux SSE Gemini (un GenerateContentResponse par événement). */
export class GeminiStream {
  constructor(model) { this.model = model; this.calls = new Map(); this.usage = null; this.finish = null; }

  push(chunk) {
    const out = [];
    if (chunk.usage) this.usage = chunk.usage;
    const c = chunk.choices?.[0];
    if (!c) return out;
    const d = c.delta ?? {};
    if (d.content) out.push(sseData({ candidates: [{ content: { role: 'model', parts: [{ text: d.content }] }, index: 0 }], modelVersion: this.model }));
    for (const tc of d.tool_calls ?? []) {
      const cur = this.calls.get(tc.index ?? 0) ?? { name: '', args: '' };
      if (tc.function?.name) cur.name = tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      this.calls.set(tc.index ?? 0, cur);
    }
    if (c.finish_reason) this.finish = c.finish_reason;
    return out;
  }

  end() {
    const parts = [...this.calls.values()].filter((x) => x.name).map((x) => ({ functionCall: { name: x.name, args: argsOf(x.args) } }));
    const last = { candidates: [{ content: { role: 'model', parts: parts.length ? parts : [{ text: '' }] }, finishReason: FINISH[this.finish] ?? 'STOP', index: 0 }], modelVersion: this.model };
    const u = usage(this.usage);
    if (u) last.usageMetadata = u;
    return [sseData(last)];
  }
}

export const geminiError = (status, message) => ({ error: { code: status, message, status: status === 429 ? 'RESOURCE_EXHAUSTED' : status === 401 ? 'UNAUTHENTICATED' : status === 404 ? 'NOT_FOUND' : status === 400 ? 'INVALID_ARGUMENT' : status === 403 ? 'PERMISSION_DENIED' : 'INTERNAL' } });
