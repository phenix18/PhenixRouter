// Copyright (c) 2026 Fido-labs —kcw—
import { h, icon, toast, fmtMs } from '../dom.js';
import { t } from '../i18n.js';
import { api } from '../api.js';

/** Lit un flux SSE OpenAI et appelle onDelta pour chaque fragment de texte. */
async function streamChat(body, signal, onDelta) {
  const res = await fetch('/v1/chat/completions', { method: 'POST', credentials: 'same-origin', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.error?.message ?? msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const served = res.headers.get('x-phenix-provider') ? `${res.headers.get('x-phenix-provider')}/${res.headers.get('x-phenix-model') ?? ''}` : '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          if (j.error) throw new Error(j.error.message ?? 'erreur de flux');
          const d = j.choices?.[0]?.delta?.content;
          if (d) onDelta(d);
        } catch (e) { if (e.message && !(e instanceof SyntaxError)) throw e; }
      }
    }
  }
  return served;
}

export async function render(root, ctx) {
  const { models } = await api('/api/models');
  const chatModels = models.filter((m) => m.status === 'ready' && m.tags.includes('chat'));
  const select = h('select', { 'aria-label': t('play_model') },
    ['phenix/auto', 'phenix/fast', 'phenix/smart', 'phenix/code'].map((v) => h('option', { value: v }, v)),
    h('optgroup', { label: t('models_title') }, chatModels.slice(0, 300).map((m) => h('option', { value: m.id }, m.id))));
  const system = h('textarea', { rows: 2, placeholder: t('play_system'), 'aria-label': t('play_system') });
  const temp = h('input', { type: 'number', min: 0, max: 2, step: 0.1, value: 0.7, 'aria-label': t('play_temp') });
  const stream = h('input', { type: 'checkbox', checked: true });
  const log = h('div', { class: 'chat-log', 'aria-live': 'polite' });
  const input = h('textarea', { rows: 2, placeholder: t('play_placeholder'), 'aria-label': t('play_placeholder') });
  const info = h('div', { class: 'muted small' });
  const history = [];
  let ctrl;

  const bubble = (role, text) => { const b = h('div', { class: `msg ${role}` }, text); log.append(b); log.scrollTop = log.scrollHeight; return b; };
  const sendBtn = h('button', { class: 'btn primary', type: 'button' }, icon('play'), ' ', t('play_send'));

  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    if (ctrl) { ctrl.abort(); return; }
    input.value = '';
    history.push({ role: 'user', content: text });
    bubble('user', text);
    const out = bubble('assistant', '…');
    const messages = [...(system.value.trim() ? [{ role: 'system', content: system.value.trim() }] : []), ...history];
    const body = { model: select.value, messages, temperature: Number(temp.value), stream: stream.checked };
    ctrl = new AbortController();
    sendBtn.replaceChildren(t('play_stop'));
    const t0 = Date.now();
    let acc = '';
    try {
      if (stream.checked) {
        out.textContent = '';
        const served = await streamChat(body, ctrl.signal, (d) => { acc += d; out.textContent = acc; log.scrollTop = log.scrollHeight; });
        info.textContent = `${served ? `${t('play_served')} ${served} · ` : ''}${fmtMs(Date.now() - t0)}`;
      } else {
        const res = await fetch('/v1/chat/completions', { method: 'POST', credentials: 'same-origin', signal: ctrl.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error?.message ?? `HTTP ${res.status}`);
        acc = j.choices?.[0]?.message?.content ?? '';
        out.textContent = acc;
        info.textContent = `${t('play_served')} ${j.model ?? res.headers.get('x-phenix-provider') ?? ''} · ${fmtMs(Date.now() - t0)}`;
      }
      history.push({ role: 'assistant', content: acc });
    } catch (e) {
      if (e.name !== 'AbortError') { out.classList.add('err'); out.textContent = e.message; toast(e.message, 'err'); history.pop(); }
      else if (acc) history.push({ role: 'assistant', content: acc });
    } finally {
      ctrl = null;
      sendBtn.replaceChildren(icon('play'), ' ', t('play_send'));
    }
  };
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  ctx.cleanup(() => ctrl?.abort());

  root.append(h('div', { class: 'page-head' }, h('h1', null, t('play_title')), h('p', null, t('play_sub'))),
    h('div', { class: 'card' },
      h('div', { class: 'toolbar' }, select, h('label', { class: 'check' }, t('play_temp'), temp), h('label', { class: 'check' }, stream, t('play_stream')),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { history.length = 0; log.replaceChildren(); info.textContent = ''; } }, icon('trash'), ' ', t('play_clear'))),
      system, log, info, h('div', { class: 'row' }, input, sendBtn)));
}
