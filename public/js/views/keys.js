// Copyright (c) 2026 Fido-labs —kcw—
import { h, icon, toast, modal, confirmDialog, copyBox, fmtTime } from '../dom.js';
import { t } from '../i18n.js';
import { api, baseUrl } from '../api.js';

function snippets(key) {
  const u = baseUrl();
  return [
    ['keys_claude', `export ANTHROPIC_BASE_URL="${u}"\nexport ANTHROPIC_AUTH_TOKEN="${key}"\nexport ANTHROPIC_MODEL="phenix/auto"\nexport ANTHROPIC_SMALL_FAST_MODEL="phenix/fast"\nclaude`],
    ['keys_codex', `export OPENAI_BASE_URL="${u}/v1"\nexport OPENAI_API_KEY="${key}"\ncodex --model phenix/code`],
    ['keys_generic', `Base URL : ${u}/v1\nAPI Key  : ${key}\nModel    : phenix/auto`],
    ['keys_curl', `curl ${u}/v1/chat/completions \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"phenix/auto","messages":[{"role":"user","content":"Bonjour !"}]}'`],
  ];
}

export async function render(root) {
  const keysHost = h('div', { class: 'card flush' });
  const toolsHost = h('div', { class: 'card' });
  const drawTools = (key) => toolsHost.replaceChildren(h('h3', null, t('keys_tools')), h('p', { class: 'muted small' }, t('keys_replaceKey')),
    snippets(key).map(([k, code]) => h('div', null, h('label', { class: 'lbl' }, t(k)), h('div', { class: 'codewrap' }, h('pre', { class: 'code' }, code),
      h('button', { class: 'btn sm ghost copy-abs', type: 'button', 'aria-label': t('copy'), onclick: () => navigator.clipboard?.writeText(code).then(() => toast(t('copied'), 'ok')) }, icon('copy'))))));

  const load = async () => {
    const { keys } = await api('/api/keys');
    keysHost.replaceChildren(h('div', { class: 'table-wrap' }, keys.length ? h('table', null,
      h('thead', null, h('tr', null, [t('keys_name'), t('keys_prefix'), t('keys_lastUsed'), t('keys_limit'), '', ''].map((x) => h('th', null, x)))),
      h('tbody', null, keys.map((k) => h('tr', null,
        h('td', null, k.name), h('td', { class: 'mono' }, `${k.prefix ?? 'phx-'}…`), h('td', null, fmtTime(k.lastUsedAt)), h('td', null, k.rateLimitPerMin || '∞'),
        h('td', null, h('label', { class: 'switch', title: k.enabled ? t('keys_active') : t('keys_disabled') }, h('input', { type: 'checkbox', checked: k.enabled !== false, onchange: async (e) => {
          try { await api(`/api/keys/${k.id}`, { method: 'PATCH', body: { enabled: e.target.checked } }); } catch (err) { toast(err.message, 'err'); e.target.checked = !e.target.checked; }
        } }), h('i'))),
        h('td', null, h('button', { class: 'btn sm danger', type: 'button', 'aria-label': t('delete'), onclick: async () => {
          if (!await confirmDialog(`${t('delete')} « ${k.name} » ?`, { danger: true, ok: t('delete') })) return;
          try { await api(`/api/keys/${k.id}`, { method: 'DELETE' }); load(); } catch (e) { toast(e.message, 'err'); }
        } }, icon('trash'))))))) : h('p', { class: 'muted pad' }, t('keys_none'))));
  };

  const create = async () => {
    const name = h('input', { type: 'text', maxlength: 60, placeholder: 'claude-code' });
    const limit = h('input', { type: 'number', min: 0, value: 0 });
    const ok = await modal(t('keys_new'), h('div', { class: 'form' }, h('label', { class: 'lbl' }, t('keys_name'), name), h('label', { class: 'lbl' }, t('keys_limit'), limit)), { actions: [
      { label: t('cancel'), value: false },
      { label: t('add'), primary: true, value: true, onClick: async (close) => {
        try {
          const r = await api('/api/keys', { method: 'POST', body: { name: name.value.trim() || 'key', rateLimitPerMin: Number(limit.value) || 0 } });
          close(false);
          drawTools(r.key);
          await modal(t('keys_created'), h('div', null, h('p', null, t('keys_once')), copyBox(r.key)), { actions: [{ label: t('close'), primary: true, value: true }] });
          load();
        } catch (e) { toast(e.message, 'err'); return false; }
      } }] });
    return ok;
  };

  root.append(h('div', { class: 'page-head row between' }, h('div', null, h('h1', null, t('keys_title')), h('p', null, t('keys_sub'))),
    h('button', { class: 'btn primary', type: 'button', onclick: create }, icon('plus'), ' ', t('keys_new'))), keysHost, toolsHost);
  drawTools('VOTRE_CLE');
  await load();
}
