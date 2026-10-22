// Copyright (c) 2026 Fido-labs —kcw—
import { h, icon, toast, modal, confirmDialog, statusBadge, ago } from '../dom.js';
import { t } from '../i18n.js';
import { api } from '../api.js';

async function addDialog(p, proxies = []) {
  const key = h('input', { type: 'password', autocomplete: 'off', placeholder: p.keyEnv ?? 'sk-…', 'aria-label': t('prov_key') });
  const name = h('input', { type: 'text', placeholder: p.name, maxlength: 60 });
  const base = h('input', { type: 'url', placeholder: 'https://…/v1' });
  const extra = {};
  const extras = (p.needs ?? []).map((n) => {
    const i = h('input', { type: 'text', oninput: (e) => { extra[n] = e.target.value.trim(); } });
    return h('label', { class: 'lbl' }, n === 'accountId' ? t('prov_account') : n === 'cx' ? t('prov_cx') : n, i);
  });
  const proxy = h('select', null, h('option', { value: '' }, t('prov_proxyNone')), ...(proxies.length ? [h('option', { value: 'pool' }, t('prov_proxyPool'))] : []), proxies.map((x) => h('option', { value: x.id }, x.name)));
  const limit = h('input', { type: 'number', min: 0, value: 0 });
  const prio = h('input', { type: 'number', min: 1, max: 99, value: 5 });
  const body = h('div', { class: 'form' },
    h('label', { class: 'lbl' }, t('prov_name'), name),
    p.keyless ? null : h('label', { class: 'lbl' }, t('prov_key'), key, h('small', { class: 'muted' }, t('prov_keyHint'))),
    p.custom ? h('label', { class: 'lbl' }, t('prov_baseUrl'), base) : null, extras,
    h('label', { class: 'lbl' }, t('prov_dailyLimit'), limit), h('label', { class: 'lbl' }, t('prov_priority'), prio),
    proxies.length ? h('label', { class: 'lbl' }, t('prov_proxy'), proxy) : null,
    p.tier === 'paid' ? h('div', { class: 'notice warn' }, t('prov_paidNote')) : null,
    p.signup ? h('a', { href: p.signup, target: '_blank', rel: 'noopener noreferrer' }, t('prov_getKey'), ' ', icon('external')) : null);
  return modal(`${t('prov_addKey')} — ${p.name}`, body, { actions: [
    { label: t('cancel'), value: false },
    { label: t('add'), primary: true, value: true, onClick: async () => {
      try {
        await api('/api/connections', { method: 'POST', body: {
          provider: p.id, name: name.value.trim() || undefined, apiKey: key.value.trim() || undefined,
          baseUrl: base.value.trim() || undefined, extra, dailyLimit: Number(limit.value) || 0, priority: Number(prio.value) || 5, proxyId: proxy.value || undefined } });
        toast(t('prov_added'), 'ok');
      } catch (e) { toast(e.message, 'err'); return false; }
    } }] });
}

function connRow(c, reload) {
  const implicit = c.id.startsWith('env:') || c.id.startsWith('auto:');
  const res = h('span', { class: 'muted' });
  return h('div', { class: 'conn' },
    h('div', { class: 'grow' },
      h('b', null, c.name), ' ', c.keyHint ? h('code', null, c.keyHint) : null, ' ',
      c.id.startsWith('env:') ? h('span', { class: 'tag' }, 'ENV') : null, c.id.startsWith('auto:') ? h('span', { class: 'tag' }, t('prov_auto')) : null,
      h('div', { class: 'muted small' },
        `${c.today ?? 0} ${t('prov_today')}${c.dailyLimit ? ` / ${c.dailyLimit}` : ''}`,
        ` · P${c.priority ?? 5}`, c.proxyId ? ` · ${t('prov_via')}` : '',
        c.cooldownLeftMs > 0 ? ` · ${t('prov_cooldown')} ${Math.ceil(c.cooldownLeftMs / 1000)}s` : '',
        c.health?.lastOkAt ? ` · OK ${ago(c.health.lastOkAt)}` : '',
        c.probe && c.probe.ok === false ? ` · ✗ ${t('prov_probeFail')} (${c.probe.status ?? c.probe.message ?? ''})` : '',
        c.probe && c.probe.ok === true ? ` · ✓ ${t('prov_probeOk')} ${ago(c.probe.at)}` : '', ' ', res)),
    c.implicit || c.id.startsWith('env:') ? null : h('label', { class: 'small muted', title: t('prov_resale') }, h('input', { type: 'checkbox', checked: c.resale === true, onchange: async (e) => {
      try { await api(`/api/connections/${encodeURIComponent(c.id)}`, { method: 'PATCH', body: { resale: e.target.checked } }); } catch (err) { toast(err.message, 'err'); e.target.checked = !e.target.checked; }
    } }), ' ', t('prov_resale')),
    h('label', { class: 'switch', title: t('statusReady') }, h('input', { type: 'checkbox', checked: c.enabled !== false, onchange: async (e) => {
      try { await api(`/api/connections/${encodeURIComponent(c.id)}`, { method: 'PATCH', body: { enabled: e.target.checked } }); } catch (err) { toast(err.message, 'err'); e.target.checked = !e.target.checked; }
    } }), h('i')),
    h('button', { class: 'btn sm', type: 'button', onclick: async () => {
      res.textContent = t('prov_testing');
      try {
        const r = await api(`/api/connections/${encodeURIComponent(c.id)}/test`, { method: 'POST' });
        res.textContent = r.ok ? `✓ ${t('prov_testOk')} (${r.models ?? ''} ${r.models != null ? t('prov_models') : ''} ${r.ms} ms)` : `✗ ${r.message ?? t('prov_testFail')}`;
      } catch (e) { res.textContent = `✗ ${e.message}`; }
    } }, icon('play'), ' ', t('test')),
    implicit ? null : h('button', { class: 'btn sm danger', type: 'button', 'aria-label': t('delete'), onclick: async () => {
      if (!await confirmDialog(t('prov_deleteConfirm'), { danger: true, ok: t('delete') })) return;
      try { await api(`/api/connections/${encodeURIComponent(c.id)}`, { method: 'DELETE' }); reload(); } catch (e) { toast(e.message, 'err'); }
    } }, icon('trash')));
}

export async function render(root, ctx) {
  const host = h('div', { class: 'stack' });
  root.append(h('div', { class: 'page-head' }, h('h1', null, t('prov_title')), h('p', null, t('prov_sub')),
    h('button', { class: 'btn sm', type: 'button', onclick: async (e) => {
      e.target.disabled = true;
      try { await api('/api/probe/run', { method: 'POST' }); toast(t('prov_probeDone')); await load(); } catch (err) { toast(err.message, 'err'); } finally { e.target.disabled = false; }
    } }, icon('play'), ' ', t('prov_probeNow'))), host);
  const load = async () => {
    const [{ providers }, { proxies }] = await Promise.all([api('/api/providers'), api('/api/proxies')]);
    const card = (p) => h('div', { class: 'card prov' },
      h('div', { class: 'row between' },
        h('div', null, h('h3', null, p.name, ' ', statusBadge(p.status),
          p.tier === 'paid' ? h('span', { class: 'tag warn' }, t('tier_paid')) : null, p.keyless ? h('span', { class: 'tag' }, t('prov_keyless')) : null, p.local ? h('span', { class: 'tag' }, t('prov_local')) : null,
          p.experimental ? h('span', { class: 'tag warn' }, t('prov_experimental')) : null),
          h('p', { class: 'muted small' }, (p.caps ?? []).map((c) => h('span', { class: 'tag' }, t(`cap_${c}`))), ' ', p.note ?? '', ' ', `${p.modelCount} ${t('prov_models')}`, p.discoveryError ? ` · ⚠ ${p.discoveryError}` : '')),
        h('div', { class: 'row' },
          p.signup ? h('a', { class: 'btn sm ghost', href: p.signup, target: '_blank', rel: 'noopener noreferrer' }, t('prov_getKey'), ' ', icon('external')) : null,
          h('button', { class: 'btn sm primary', type: 'button', onclick: async () => { if (await addDialog(p, proxies)) load(); } }, icon('plus'), ' ', t('prov_addKey')))),
      p.connections.length ? p.connections.map((c) => connRow(c, load)) : h('p', { class: 'muted small' }, t('prov_noConn')));
    host.replaceChildren(
      h('h2', { class: 'group' }, t('prov_groupFree')), ...providers.filter((p) => p.tier !== 'paid' && !p.mediaOnly).map(card),
      h('h2', { class: 'group' }, t('prov_groupPaid')), ...providers.filter((p) => p.tier === 'paid' && !p.mediaOnly).map(card),
      h('h2', { class: 'group' }, t('prov_groupMedia')), ...providers.filter((p) => p.mediaOnly).map(card));
  };
  await load();
  ctx.cleanup(subscribe_catalog(load));
}

import { subscribe } from '../api.js';
function subscribe_catalog(load) {
  let timer;
  const stop = subscribe((ev) => { if (ev.type === 'catalog') { clearTimeout(timer); timer = setTimeout(load, 400); } });
  return () => { clearTimeout(timer); stop(); };
}
