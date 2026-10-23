// Copyright (c) 2026 Fido-labs —kcw—
import { h, icon, toast, copyButton, statusBadge, fmtMs, fmtCompact, debounce } from '../dom.js';
import { t } from '../i18n.js';
import { api } from '../api.js';

export async function render(root) {
  let data = await api('/api/models');
  const f = { q: '', provider: '', tag: '', readyOnly: false, tier: '', coding: false };
  const body = h('tbody');
  const count = h('span', { class: 'muted' });

  const draw = () => {
    const q = f.q.toLowerCase();
    const rows = data.models.filter((m) => (!q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
      && (!f.coding || m.codingScore != null) && (!f.provider || m.provider === f.provider) && (!f.tier || m.tier === f.tier) && (!f.tag || m.tags.includes(f.tag)) && (!f.readyOnly || m.status === 'ready'))
      .sort((a, b) => (a.status === 'ready' ? 0 : 1) - (b.status === 'ready' ? 0 : 1) || (f.coding ? (b.codingScore ?? 0) - (a.codingScore ?? 0) : b.quality - a.quality));
    count.textContent = `${rows.length} ${t('models_count')}`;
    body.replaceChildren(...(rows.length ? rows.slice(0, 400).map((m) => {
      const res = h('span', { class: 'muted' });
      return h('tr', null,
        h('td', { class: 'mono' }, h('div', null, m.id), h('small', { class: 'muted' }, m.source === 'live' ? t('models_live') : t('models_static'))),
        h('td', null, m.providerName), h('td', null, statusBadge(m.status)),
        h('td', null, m.tier === 'paid' ? h('span', { class: 'tag warn' }, m.price?.known ? `${t('tier_paid')} · ~${m.price.in}/${m.price.out} $` : `${t('tier_paid')} · ${t('models_priceUnknown')}`) : h('span', { class: 'badge ok' }, t('tier_free'))),
        h('td', null, m.ctx ? fmtCompact(m.ctx) : '—'),
        h('td', null, m.family && m.family !== 'other' ? h('span', { class: 'tag info' }, m.family) : null, m.tags.map((x) => h('span', { class: 'tag' }, x))),
        h('td', { class: 'nowrap' }, copyButton(m.id),
          h('button', { class: 'btn sm ghost', type: 'button', title: t('test'), disabled: m.status !== 'ready',
            onclick: async (e) => {
              res.textContent = t('models_testing');
              try {
                const r = await api('/api/models/test', { method: 'POST', body: { model: m.id } });
                res.textContent = r.ok ? `✓ ${fmtMs(r.ms)}` : `✗ ${r.message}`;
              } catch (err) { res.textContent = `✗ ${err.message}`; }
              e.target.blur();
            } }, icon('play')), res));
    }) : [h('tr', null, h('td', { colspan: 7, class: 'muted' }, t('models_none')))]));
  };

  const providers = [...new Map(data.models.map((m) => [m.provider, m.providerName])).entries()];
  const tags = [...new Set(data.models.flatMap((m) => m.tags))].sort();
  const refresh = h('button', { class: 'btn', type: 'button', onclick: async (e) => {
    e.currentTarget.disabled = true;
    try { await api('/api/models/refresh', { method: 'POST' }); data = await api('/api/models'); draw(); toast(t('models_updated'), 'ok'); }
    catch (err) { toast(err.message, 'err'); } finally { e.currentTarget.disabled = false; }
  } }, icon('refresh'), ' ', t('refresh'));

  root.append(
    h('div', { class: 'page-head' }, h('h1', null, t('models_title')), h('p', null, t('models_sub'), ' ', t('models_tryAuto'))),
    h('div', { class: 'toolbar' },
      h('input', { type: 'search', placeholder: t('models_search'), 'aria-label': t('models_search'), oninput: debounce((e) => { f.q = e.target.value; draw(); }) }),
      h('select', { 'aria-label': t('models_provider'), onchange: (e) => { f.provider = e.target.value; draw(); } },
        h('option', { value: '' }, `${t('models_provider')} : ${t('all')}`), providers.map(([id, n]) => h('option', { value: id }, n))),
      h('select', { 'aria-label': t('models_capabilities'), onchange: (e) => { f.tag = e.target.value; draw(); } },
        h('option', { value: '' }, `${t('models_capabilities')} : ${t('all')}`), tags.map((x) => h('option', { value: x }, x))),
      h('select', { 'aria-label': t('models_tier'), onchange: (e) => { f.tier = e.target.value; draw(); } },
        h('option', { value: '' }, `${t('models_tier')} : ${t('tier_all')}`), h('option', { value: 'free' }, t('tier_free')), h('option', { value: 'paid' }, t('tier_paid'))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => { f.coding = e.target.checked; if (f.coding) f.tier = 'free'; draw(); } }), t('models_coding')),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => { f.readyOnly = e.target.checked; draw(); } }), t('statusReady')),
      refresh, count),
    h('div', { class: 'card flush' }, h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['models_title', 'models_provider', 'models_status', 'models_price', 'models_ctx', 'models_capabilities', ''].map((k) => h('th', null, k && t(k))))),
      body))));
  draw();
}
