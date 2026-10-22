// Copyright (c) 2026 Fido-labs —kcw—
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicToOpenAI, openAIToAnthropic, AnthropicStream, mapToolChoice,
} from '../src/core/translate/anthropic.js';
import { responsesToChat, chatToResponses, ResponsesStream } from '../src/core/translate/responses.js';

const parseEvents = (arr) => arr.map((s) => {
  const [e, d] = s.trim().split('\n');
  return { event: e.replace('event: ', ''), data: JSON.parse(d.replace('data: ', '')) };
});

test('Anthropic → OpenAI : système, texte, outils et résultats d’outils', () => {
  const out = anthropicToOpenAI({
    model: 'claude-x', max_tokens: 100, stream: true, system: [{ type: 'text', text: 'Sois bref.' }],
    stop_sequences: ['FIN'], tool_choice: { type: 'any' },
    tools: [{ name: 'get_weather', description: 'Météo', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
    messages: [
      { role: 'user', content: 'Météo à Paris ?' },
      { role: 'assistant', content: [{ type: 'text', text: 'Je vérifie.' }, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '18°C' }] }, { type: 'text', text: 'Merci' }] },
    ],
  });
  assert.equal(out.messages[0].role, 'system');
  assert.equal(out.messages[0].content, 'Sois bref.');
  assert.equal(out.messages[2].tool_calls[0].function.name, 'get_weather');
  assert.equal(JSON.parse(out.messages[2].tool_calls[0].function.arguments).city, 'Paris');
  assert.equal(out.messages[3].role, 'tool');
  assert.equal(out.messages[3].tool_call_id, 'toolu_1');
  assert.equal(out.messages[3].content, '18°C');
  assert.equal(out.messages[4].role, 'user');
  assert.equal(out.tool_choice, 'required');
  assert.deepEqual(out.stop, ['FIN']);
  assert.equal(out.tools[0].function.parameters.properties.city.type, 'string');
  assert.deepEqual(out.stream_options, { include_usage: true });
});

test('Anthropic → OpenAI : images base64', () => {
  const out = anthropicToOpenAI({
    model: 'm', max_tokens: 5,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Décris' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }],
  });
  assert.equal(out.messages[0].content[1].image_url.url, 'data:image/png;base64,AAAA');
});

test('mapToolChoice', () => {
  assert.equal(mapToolChoice({ type: 'auto' }), 'auto');
  assert.deepEqual(mapToolChoice({ type: 'tool', name: 'f' }), { type: 'function', function: { name: 'f' } });
  assert.equal(mapToolChoice(undefined), undefined);
});

test('OpenAI → Anthropic (réponse non diffusée) avec appel d’outil', () => {
  const r = openAIToAnthropic({
    choices: [{ message: { content: 'ok', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 7, completion_tokens: 3 },
  }, 'claude-x');
  assert.equal(r.type, 'message');
  assert.equal(r.model, 'claude-x');
  assert.equal(r.stop_reason, 'tool_use');
  assert.deepEqual(r.content[1], { type: 'tool_use', id: 'c1', name: 'f', input: { a: 1 } });
  assert.deepEqual(r.usage, { input_tokens: 7, output_tokens: 3 });
});

test('AnthropicStream : séquence d’événements texte', () => {
  const tr = new AnthropicStream('claude-x', 9);
  const evs = [...tr.start()];
  evs.push(...tr.push({ choices: [{ delta: { role: 'assistant', content: '' } }] }));
  evs.push(...tr.push({ choices: [{ delta: { content: 'Bon' } }] }));
  evs.push(...tr.push({ choices: [{ delta: { content: 'jour' } }] }));
  evs.push(...tr.push({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
  evs.push(...tr.push({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } }));
  evs.push(...tr.end());
  const names = parseEvents(evs).map((e) => e.event);
  assert.deepEqual(names, ['message_start', 'ping', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  const delta = parseEvents(evs).find((e) => e.event === 'message_delta').data;
  assert.equal(delta.delta.stop_reason, 'end_turn');
  assert.equal(delta.usage.output_tokens, 2);
});

test('AnthropicStream : appels d’outils fragmentés → un bloc tool_use complet', () => {
  const tr = new AnthropicStream('m', 1);
  const evs = [...tr.start()];
  evs.push(...tr.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_weather', arguments: '{"city"' } }] } }] }));
  evs.push(...tr.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"Paris"}' } }] } }] }));
  evs.push(...tr.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
  evs.push(...tr.end(4));
  const parsed = parseEvents(evs);
  const start = parsed.find((e) => e.event === 'content_block_start').data;
  assert.equal(start.content_block.type, 'tool_use');
  assert.equal(start.content_block.name, 'get_weather');
  const json = parsed.find((e) => e.event === 'content_block_delta').data.delta.partial_json;
  assert.deepEqual(JSON.parse(json), { city: 'Paris' });
  assert.equal(parsed.find((e) => e.event === 'message_delta').data.delta.stop_reason, 'tool_use');
});

test('AnthropicStream : flux vide → bloc texte vide valide', () => {
  const tr = new AnthropicStream('m', 1);
  const names = parseEvents([...tr.start(), ...tr.end()]).map((e) => e.event);
  assert.ok(names.includes('content_block_start'));
  assert.equal(names.at(-1), 'message_stop');
});

test('Responses → Chat : instructions, messages, appels et sorties de fonctions', () => {
  const out = responsesToChat({
    model: 'm', instructions: 'Sois utile', max_output_tokens: 50, stream: false,
    tools: [{ type: 'function', name: 'f', description: 'd', parameters: { type: 'object', properties: {} } }],
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Salut' }] },
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'résultat' },
    ],
  });
  assert.equal(out.messages[0].role, 'system');
  assert.equal(out.messages[1].content, 'Salut');
  assert.equal(out.messages[2].tool_calls[0].id, 'c1');
  assert.equal(out.messages[3].role, 'tool');
  assert.equal(out.max_tokens, 50);
  assert.equal(out.tools[0].function.name, 'f');
});

test('Chat → Responses (objet) et flux d’événements', () => {
  const r = chatToResponses({ choices: [{ message: { content: 'Salut' } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }, 'm');
  assert.equal(r.object, 'response');
  assert.equal(r.output[0].content[0].text, 'Salut');
  assert.equal(r.usage.total_tokens, 3);

  const tr = new ResponsesStream('m');
  const evs = [...tr.start(), ...tr.push({ choices: [{ delta: { content: 'Sa' } }] }), ...tr.push({ choices: [{ delta: { content: 'lut' } }] }), ...tr.end()];
  const names = parseEvents(evs).map((e) => e.event);
  assert.equal(names[0], 'response.created');
  assert.ok(names.includes('response.output_text.delta'));
  assert.equal(names.at(-1), 'response.completed');
  const done = parseEvents(evs).find((e) => e.event === 'response.output_text.done').data;
  assert.equal(done.text, 'Salut');
});
