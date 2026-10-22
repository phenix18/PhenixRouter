// Copyright (c) 2026 Fido-labs —kcw—
import { h, icon, fmtTime, fmtMs, fmtInt } from '../dom.js';
import { t } from '../i18n.js';
import { api, subscribe } from '../api.js';

export async function render(root, ctx) {
  const exBody = h('tbody');
  const evBody = h('tbody');
  const exRow = (ex) => h('tr', null,
    h('td', { class: 'nowrap' }, fmtTime(ex.ts)), h('td', null, ex.client), h('td', null, ex.route ?? ''),
    h('td', { class: 'mono' }, `${ex.provider}/${ex.model ?? '?'}`), h('td', null, `${fmtInt(ex.tokensIn)} / ${fmtInt(ex.tokensOut)}`),
    h('td', null, ex.cached ? t('logs_cached') : fmtMs(ex.ms)),
    h('td', null, h('span', { class: `badge ${ex.status === 'ok' ? 'ok' : 'err'}`, title: ex.error ?? '' }, ex.status)));
  const evRow = (l) => h('tr', null, h('td', { class: 'nowrap' }, fmtTime(l.ts)),
    h('td', null, h('span', { class: `badge ${l.level === 'error' ? 'err' : l.level === 'warn' ? 'warn' : ''}` }, l.level ?? 'info')), h('td', { class: 'mono wrap' }, l.message ?? ''));

  const load = async () => {
    const { logs, exchanges } = await api('/api/logs?limit=200');
    exBody.replaceChildren(...(exchanges.length ? exchanges.map(exRow) : [h('tr', null, h('td', { colspan: 7, class: 'muted' }, t('logs_none')))]));
    evBody.replaceChildren(...logs.slice(0, 100).map(evRow));
  };
  await load();
  ctx.cleanup(subscribe((ev) => {
    if (ev.type === 'exchange') exBody.prepend(exRow(ev.exchange));
    if (ev.type === 'log') evBody.prepend(evRow(ev.log));
  }));
  root.append(h('div', { class: 'page-head row between' }, h('div', null, h('h1', null, t('logs_title')), h('p', null, t('logs_sub'))),
    h('button', { class: 'btn', type: 'button', onclick: load }, icon('refresh'), ' ', t('refresh'))),
    h('div', { class: 'card flush' }, h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['logs_time', 'logs_client', 'logs_route', 'logs_model', 'logs_tokens', 'logs_ms', 'logs_status'].map((k) => h('th', null, t(k))))), exBody))),
    h('div', { class: 'card flush' }, h('h3', { class: 'pad' }, t('logs_events')), h('div', { class: 'table-wrap' }, h('table', null, evBody))));
}
