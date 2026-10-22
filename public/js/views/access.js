// Copyright (c) 2026 Fido-labs —kcw—
// Accès & proxys : outils clients (écriture de config), serveur MCP, tunnel distant, proxys sortants.
import { h, icon, toast, modal, confirmDialog } from '../dom.js';
import { t } from '../i18n.js';
import { api } from '../api.js';

const copyBtn = (text) => h('button', { class: 'btn sm ghost', type: 'button', 'aria-label': 'copy', onclick: async () => {
  try { await navigator.clipboard.writeText(text); toast(t('copied') ?? 'OK', 'ok'); } catch { toast('—', 'err'); }
} }, icon('copy'));

const codeBlock = (text) => h('div', { class: 'codeblock' }, h('pre', null, text), copyBtn(text));

function toolsCard(info, reload) {
  const rows = info.tools.map((tool) => h('div', { class: 'conn' },
    h('div', { class: 'grow' }, h('b', null, tool.label), h('div', { class: 'muted small' }, `${t('acc_file')} : `, h('code', null, tool.file), tool.exists ? ' ✓' : '', tool.note ? ` — ${tool.note}` : '')),
    h('button', { class: 'btn sm primary', type: 'button', onclick: async () => {
      try { const r = await api(`/api/clitools/${tool.id}/apply`, { method: 'POST' }); toast(`${t('acc_applied')} : ${r.file}`, 'ok'); reload(); } catch (e) { toast(e.message, 'err'); }
    } }, t('acc_apply')),
    h('button', { class: 'btn sm', type: 'button', onclick: async () => {
      try { const r = await api(`/api/clitools/${tool.id}/remove`, { method: 'POST' }); toast(r.removed ? t('acc_removed') : t('acc_nothing'), r.removed ? 'ok' : ''); } catch (e) { toast(e.message, 'err'); }
    } }, t('acc_remove'))));
  const manual = Object.entries(info.manual).map(([k, v]) => h('details', null, h('summary', null, k), codeBlock(v)));
  return h('div', { class: 'card' }, h('h3', null, t('acc_tools')), h('p', { class: 'muted small' }, t('acc_toolsNote')), rows,
    h('h4', null, t('acc_manual')), manual,
    h('h4', null, t('acc_mcp')), h('p', { class: 'muted small' }, t('acc_mcpNote')),
    codeBlock(`claude mcp add --transport http phenix ${info.baseUrl}/mcp --header "Authorization: Bearer phx-VOTRE_CLE"`));
}

function tunnelCard(st, reload) {
  const label = st.status === 'running' ? t('acc_running') : st.status === 'starting' ? t('acc_starting') : t('acc_stopped');
  const start = (provider) => h('button', { class: 'btn sm primary', type: 'button', disabled: !st.available[provider] || st.status === 'running' || st.status === 'starting', onclick: async (e) => {
    e.target.disabled = true;
    try { await api('/api/tunnel/start', { method: 'POST', body: { provider } }); toast(t('acc_running'), 'ok'); } catch (err) { toast(err.message, 'err'); }
    reload();
  } }, `${t('acc_start')} ${provider}`, st.available[provider] ? '' : ` (${t('acc_missing')})`);
  return h('div', { class: 'card' }, h('h3', null, t('acc_tunnel'), ' ', h('span', { class: `tag ${st.status === 'running' ? '' : 'warn'}` }, label)),
    h('p', { class: 'muted small' }, t('acc_tunnelNote')),
    st.url ? h('p', null, h('a', { href: st.url, target: '_blank', rel: 'noopener noreferrer' }, st.url), ' ', copyBtn(st.url)) : null,
    st.error ? h('div', { class: 'notice err' }, st.error) : null,
    h('div', { class: 'row wrapr' }, start('cloudflared'), start('tailscale'),
      h('button', { class: 'btn sm danger', type: 'button', disabled: st.status !== 'running', onclick: async () => { await api('/api/tunnel/stop', { method: 'POST' }); reload(); } }, t('acc_stop'))));
}

async function addProxyDialog() {
  const name = h('input', { type: 'text', maxlength: 60, placeholder: 'proxy-1' });
  const url = h('input', { type: 'text', autocomplete: 'off', placeholder: 'http://user:pass@host:8080', 'aria-label': t('acc_proxyUrl') });
  return modal(t('acc_addProxy'), h('div', { class: 'form' }, h('label', { class: 'lbl' }, t('prov_name'), name), h('label', { class: 'lbl' }, t('acc_proxyUrl'), url)), { actions: [
    { label: t('cancel'), value: false },
    { label: t('add'), primary: true, value: true, onClick: async () => {
      try { await api('/api/proxies', { method: 'POST', body: { name: name.value.trim(), url: url.value.trim() } }); } catch (e) { toast(e.message, 'err'); return false; }
    } }] });
}

function proxiesCard(list, reload) {
  const rows = list.length ? list.map((p) => {
    const res = h('span', { class: 'muted' }, p.health ? (p.health.ok ? `✓ ${p.health.ms ?? ''} ms${p.health.ip ? ` · ${p.health.ip}` : ''}${p.health.loc ? ` (${p.health.loc})` : ''}` : `✗ ${p.health.error ?? ''}`) : '');
    return h('div', { class: 'conn' },
      h('div', { class: 'grow' }, h('b', null, p.name), ' ', h('code', null, p.url), h('div', { class: 'muted small' }, `${p.usedBy} ${t('acc_usedBy')} `, res)),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: p.enabled, onchange: async (e) => { try { await api(`/api/proxies/${p.id}`, { method: 'PATCH', body: { enabled: e.target.checked } }); } catch (err) { toast(err.message, 'err'); } } }), h('i')),
      h('button', { class: 'btn sm', type: 'button', onclick: async () => {
        res.textContent = t('prov_testing');
        try { const r = await api(`/api/proxies/${p.id}/test`, { method: 'POST' }); res.textContent = r.ok ? `✓ ${t('acc_proxyOk')} ${r.ms} ms${r.ip ? ` · ${r.ip}` : ''}` : `✗ ${r.message ?? r.status}`; } catch (e) { res.textContent = `✗ ${e.message}`; }
      } }, icon('play'), ' ', t('test')),
      h('button', { class: 'btn sm danger', type: 'button', 'aria-label': t('delete'), onclick: async () => {
        if (!await confirmDialog(t('prov_deleteConfirm'), { danger: true, ok: t('delete') })) return;
        try { await api(`/api/proxies/${p.id}`, { method: 'DELETE' }); reload(); } catch (e) { toast(e.message, 'err'); }
      } }, icon('trash')));
  }) : h('p', { class: 'muted small' }, t('acc_noProxy'));
  return h('div', { class: 'card' }, h('div', { class: 'row between' }, h('h3', null, t('acc_proxies')),
    h('button', { class: 'btn sm primary', type: 'button', onclick: async () => { if (await addProxyDialog()) reload(); } }, icon('plus'), ' ', t('acc_addProxy'))),
  h('p', { class: 'muted small' }, t('acc_proxiesNote')), rows);
}

export async function render(root) {
  const host = h('div', { class: 'stack' });
  root.append(h('div', { class: 'page-head' }, h('h1', null, t('acc_title')), h('p', null, t('acc_sub'))), host);
  const load = async () => {
    const [info, tunnel, { proxies }] = await Promise.all([api('/api/clitools'), api('/api/tunnel'), api('/api/proxies')]);
    host.replaceChildren(toolsCard(info, load), tunnelCard(tunnel, load), proxiesCard(proxies, load));
  };
  await load();
}
