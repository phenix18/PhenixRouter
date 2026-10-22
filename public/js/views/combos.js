// Copyright (c) 2026 Fido-labs —kcw—
import { h, icon, toast, modal, confirmDialog, copyButton } from '../dom.js';
import { t } from '../i18n.js';
import { api } from '../api.js';

const STRATS = ['fallback', 'roundrobin', 'fastest', 'random'];

async function comboDialog(existing, modelIds) {
  const name = h('input', { type: 'text', value: existing?.name ?? '', maxlength: 48, pattern: '[A-Za-z0-9._-]+', disabled: !!existing });
  const strat = h('select', null, STRATS.map((s) => h('option', { value: s, selected: (existing?.strategy ?? 'fallback') === s }, t(`combos_${s}`))));
  const models = h('textarea', { rows: 6, spellcheck: 'false', list: 'phx-models', placeholder: 'groq/llama-3.3-70b-versatile\ncerebras/…' });
  models.value = (existing?.models ?? []).join('\n');
  const dl = h('datalist', { id: 'phx-models' }, modelIds.slice(0, 500).map((id) => h('option', { value: id })));
  return modal(existing ? t('edit') : t('combos_new'), h('div', { class: 'form' },
    h('label', { class: 'lbl' }, t('combos_name'), name), h('label', { class: 'lbl' }, t('combos_strategy'), strat),
    h('label', { class: 'lbl' }, t('combos_models'), models), dl), { actions: [
    { label: t('cancel'), value: false },
    { label: t('save'), primary: true, value: true, onClick: async () => {
      try {
        const payload = { name: name.value.trim(), strategy: strat.value, models: models.value.split('\n').map((s) => s.trim()).filter(Boolean) };
        if (existing) await api(`/api/combos/${existing.id}`, { method: 'PUT', body: payload });
        else await api('/api/combos', { method: 'POST', body: payload });
        toast(t('saved'), 'ok');
      } catch (e) { toast(e.message, 'err'); return false; }
    } }] });
}

async function aliasDialog(modelIds) {
  const alias = h('input', { type: 'text', maxlength: 48, placeholder: 'mon-modele' });
  const target = h('input', { type: 'text', list: 'phx-models2', placeholder: 'groq/llama-3.3-70b-versatile' });
  const dl = h('datalist', { id: 'phx-models2' }, modelIds.slice(0, 500).map((id) => h('option', { value: id })));
  return modal(t('combos_newAlias'), h('div', { class: 'form' }, h('label', { class: 'lbl' }, t('combos_alias'), alias), h('label', { class: 'lbl' }, t('combos_target'), target), dl), { actions: [
    { label: t('cancel'), value: false },
    { label: t('save'), primary: true, value: true, onClick: async () => {
      try { await api('/api/aliases', { method: 'POST', body: { alias: alias.value.trim(), target: target.value.trim() } }); toast(t('saved'), 'ok'); }
      catch (e) { toast(e.message, 'err'); return false; }
    } }] });
}

export async function render(root) {
  const host = h('div', { class: 'stack' });
  root.append(h('div', { class: 'page-head' }, h('h1', null, t('combos_title')), h('p', null, t('combos_sub'))), host);
  const load = async () => {
    const [{ combos, aliases }, { models }] = await Promise.all([api('/api/combos'), api('/api/models')]);
    const ids = models.map((m) => m.id);
    const aliasEntries = Object.entries(aliases ?? {});
    host.replaceChildren(
      h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('h3', null, t('nav_combos')),
          h('button', { class: 'btn primary sm', type: 'button', onclick: async () => { if (await comboDialog(null, ids)) load(); } }, icon('plus'), ' ', t('combos_new'))),
        combos.length ? combos.map((c) => h('div', { class: 'conn' },
          h('div', { class: 'grow' }, h('b', { class: 'mono' }, `phenix/${c.name}`), ' ', h('span', { class: 'tag' }, t(`combos_${c.strategy}`)),
            h('div', { class: 'muted small mono' }, c.models.join('  →  '))),
          copyButton(`phenix/${c.name}`),
          h('button', { class: 'btn sm', type: 'button', onclick: async () => { if (await comboDialog(c, ids)) load(); } }, t('edit')),
          h('button', { class: 'btn sm danger', type: 'button', 'aria-label': t('delete'), onclick: async () => {
            if (!await confirmDialog(`${t('delete')} « ${c.name} » ?`, { danger: true, ok: t('delete') })) return;
            try { await api(`/api/combos/${c.id}`, { method: 'DELETE' }); load(); } catch (e) { toast(e.message, 'err'); }
          } }, icon('trash')))) : h('p', { class: 'muted' }, t('combos_none'))),
      h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('h3', null, t('combos_aliases')),
          h('button', { class: 'btn primary sm', type: 'button', onclick: async () => { if (await aliasDialog(ids)) load(); } }, icon('plus'), ' ', t('combos_newAlias'))),
        aliasEntries.length ? aliasEntries.map(([a, target]) => h('div', { class: 'conn' },
          h('div', { class: 'grow mono' }, a, ' → ', target),
          h('button', { class: 'btn sm danger', type: 'button', 'aria-label': t('delete'), onclick: async () => {
            try { await api(`/api/aliases/${encodeURIComponent(a)}`, { method: 'DELETE' }); load(); } catch (e) { toast(e.message, 'err'); }
          } }, icon('trash')))) : h('p', { class: 'muted' }, '—')),
      h('div', { class: 'card' }, h('h3', null, t('combos_virtual')),
        h('div', { class: 'grid two' }, ['auto', 'fast', 'smart', 'code', 'vision', 'reasoning', 'embed'].map((v) => h('div', { class: 'conn' },
          h('div', { class: 'grow' }, h('b', { class: 'mono' }, `phenix/${v}`), h('div', { class: 'muted small' }, t(`combos_virtual${v[0].toUpperCase()}${v.slice(1)}`))),
          copyButton(`phenix/${v}`))))));
  };
  await load();
}
