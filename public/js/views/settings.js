// Copyright (c) 2026 Fido-labs —kcw—
import { h, toast } from '../dom.js';
import { t, setLang, lang } from '../i18n.js';
import { api } from '../api.js';

export async function render(root, ctx) {
  const { settings: s } = await api('/api/settings');
  const num = (key, label, min = 0, max = 10 ** 9) => {
    const i = h('input', { type: 'number', min, max, value: s[key] });
    return { key, el: h('label', { class: 'lbl' }, t(label), i), get: () => Number(i.value) };
  };
  const chk = (key, label) => {
    const i = h('input', { type: 'checkbox', checked: !!s[key] });
    return { key, el: h('label', { class: 'check' }, i, t(label)), get: () => i.checked };
  };
  const txt = (key, label, multi = false) => {
    const i = multi ? h('textarea', { rows: 3, spellcheck: 'false' }) : h('input', { type: 'text', spellcheck: 'false' });
    i.value = multi ? (s[key] ?? []).join('\n') : (s[key] ?? '');
    return { key, el: h('label', { class: 'lbl' }, t(label), i), get: () => (multi ? i.value.split('\n').map((x) => x.trim()).filter(Boolean) : i.value.trim()) };
  };
  const language = h('select', null, [['fr', 'Français'], ['en', 'English']].map(([v, n]) => h('option', { value: v, selected: lang() === v }, n)));
  const fields = [
    chk('requireApiKey', 'set_requireKey'), chk('webTools', 'set_webTools'), txt('searxngUrl', 'set_searx'), num('autoChainSize', 'set_chain', 1, 20),
    num('catalogTtlMin', 'set_catalog', 1, 1440), num('firstByteTimeoutMs', 'set_firstByte', 1000), num('streamIdleTimeoutMs', 'set_stream', 1000),
    num('requestTimeoutMs', 'set_total', 1000), num('maxAttemptsPerRequest', 'set_attempts', 1, 30), chk('cacheEnabled', 'set_cacheOn'),
    num('cacheTtlSec', 'set_cacheTtl', 1), num('cacheMaxEntries', 'set_cacheMax', 1), num('rateLimitPerMin', 'set_rate', 0), txt('corsOrigins', 'set_cors', true),
  ];
  const save = async () => {
    try {
      const body = Object.fromEntries(fields.map((f) => [f.key, f.get()]));
      body.language = language.value;
      await api('/api/settings', { method: 'PUT', body });
      setLang(language.value);
      toast(t('saved'), 'ok');
      ctx.rerender();
    } catch (e) { toast(e.message, 'err'); }
  };

  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8 });
  const changePw = async () => {
    try { await api('/api/password', { method: 'POST', body: { current: cur.value, next: next.value } }); cur.value = ''; next.value = ''; toast(t('set_pwChanged'), 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };

  root.append(h('div', { class: 'page-head' }, h('h1', null, t('set_title')), h('p', null, t('set_sub'))),
    h('div', { class: 'card form' }, h('h3', null, t('set_general')), h('label', { class: 'lbl' }, t('set_language'), language), fields.map((f) => f.el),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: save }, t('save')))),
    h('div', { class: 'card form' }, h('h3', null, t('set_password')),
      h('label', { class: 'lbl' }, t('set_current'), cur), h('label', { class: 'lbl' }, t('set_new'), next),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: changePw }, t('save')))),
    h('div', { class: 'card' }, h('h3', null, t('set_about')),
      h('div', { class: 'row wrapr' },
        h('button', { class: 'btn', type: 'button', onclick: async () => { await api('/api/cache/clear', { method: 'POST' }); toast(t('set_cleared'), 'ok'); } }, t('set_clearCache')),
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          const r = await api('/api/ledger/verify');
          toast(`${r.ok ? t('ov_reaOk') : t('ov_reaBad')} — ${r.exchanges} ${t('ov_exchanges')}`, r.ok ? 'ok' : 'err');
        } }, t('set_verify')),
        h('a', { class: 'btn', href: '/api/export', download: 'phenixrouter-config.json' }, t('set_export'))),
      h('p', { class: 'muted small' }, t('set_exportNote')), h('p', { class: 'muted small' }, t('copyright'))));
}
