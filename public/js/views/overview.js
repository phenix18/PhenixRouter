// Copyright (c) 2026 Fido-labs —kcw—
import { h, icon, copyBox, fmtInt, fmtCompact, fmtMs, fmtDuration, fmtTime, statusBadge } from '../dom.js';
import { t } from '../i18n.js';
import { api, subscribe, baseUrl } from '../api.js';

function stat(label, value, sub) {
  return h('div', { class: 'card stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'sub' }, sub) : null);
}

function bars(byDay) {
  const days = [];
  for (let i = 6; i >= 0; i--) days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  const vals = days.map((d) => byDay?.[d]?.requests ?? 0);
  const max = Math.max(1, ...vals);
  return h('div', { class: 'bars', role: 'img', 'aria-label': t('ov_week') },
    days.map((d, i) => h('div', { class: 'bar-col', title: `${d} : ${vals[i]}` },
      h('div', { class: 'bar', style: `height:${Math.max(3, (vals[i] / max) * 100)}%` }),
      h('span', null, d.slice(8)))));
}

export async function render(root, ctx) {
  const o = await api('/api/overview');
  const total = o.last24h.total;
  const rate = total.requests ? Math.round((total.ok / total.requests) * 100) : null;
  const live = h('tbody');
  const feed = (ex) => {
    live.prepend(h('tr', null,
      h('td', null, fmtTime(ex.ts).slice(-8)), h('td', null, ex.client), h('td', { class: 'mono' }, `${ex.provider}/${ex.model ?? '?'}`),
      h('td', null, `${fmtCompact(ex.tokensIn)} / ${fmtCompact(ex.tokensOut)}`), h('td', null, ex.cached ? t('logs_cached') : fmtMs(ex.ms)),
      h('td', null, h('span', { class: `badge ${ex.status === 'ok' ? 'ok' : 'err'}` }, ex.status))));
    while (live.children.length > 12) live.lastChild.remove();
  };
  for (const ex of (await api('/api/logs?limit=12')).exchanges.reverse()) feed(ex);
  ctx.cleanup(subscribe((ev) => { if (ev.type === 'exchange') feed(ev.exchange); }));

  const provs = Object.entries(o.last24h.byProvider).sort((a, b) => b[1].requests - a[1].requests);
  const maxReq = Math.max(1, ...provs.map(([, v]) => v.requests));
  const key = '<VOTRE_CLE>';
  const curl = `curl ${baseUrl()}/v1/chat/completions \\\n  -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" \\\n  -d '{"model":"phenix/auto","messages":[{"role":"user","content":"Bonjour !"}]}'`;

  root.append(
    h('div', { class: 'page-head' }, h('h1', null, t('ov_title')), h('p', null, t('ov_sub'))),
    o.counts.providersReady <= 1 ? h('div', { class: 'notice warn' }, t('ov_noKeys')) : null,
    ['day', 'month'].map((k) => (o.budget?.[k]?.pct >= 80 ? h('div', { class: `notice ${o.budget[k].pct >= 100 ? 'err' : 'warn'}` }, `${t(k === 'day' ? 'bud_day' : 'bud_month')} : ${o.budget[k].spent.toFixed(2)} $ / ${o.budget[k].limit} $ (${o.budget[k].pct} %)`) : null)),
    o.onboarding && !o.onboarding.complete ? h('div', { class: 'card' }, h('h3', null, t('ob_title')),
      h('ol', { class: 'steps' }, o.onboarding.steps.map((st) => h('li', { class: st.done ? 'done' : '' },
        h('span', { class: `badge ${st.done ? 'ok' : ''}` }, st.done ? '✓' : '•'), ' ',
        h('a', { href: st.link }, t(`ob_${st.id}`)), st.optional ? h('span', { class: 'muted' }, ` (${t('ob_optional')})`) : null)))) : null,
    h('div', { class: 'grid stats' },
      stat(t('ov_requests'), fmtInt(total.requests), `${fmtInt(o.last7d.total.requests)} / 7 j`),
      stat(t('ov_success'), rate == null ? '—' : `${rate} %`),
      stat(t('ov_tokens'), `${fmtCompact(total.tokensIn)} / ${fmtCompact(total.tokensOut)}`),
      stat(t('ov_latency'), fmtMs(total.avgMs || null)),
      stat(t('ov_cost'), `${(total.costUsd ?? 0).toFixed(4)} $`, `${o.spend.day.toFixed(4)} $ ${t('ov_costToday')} · ${o.spend.month.toFixed(4)} $ ${t('ov_costMonth')} · ${o.costMode}`),
      stat(t('ov_cache'), fmtInt(total.cached), `${o.cache.hits} hits / ${o.cache.misses} miss`),
      stat(t('ov_providers'), `${o.counts.providersReady} / ${o.counts.providersTotal}`, `${fmtInt(o.counts.modelsReady)} ${t('ov_modelsReady')}`)),
    h('div', { class: 'grid two' },
      h('div', { class: 'card' }, h('h3', null, t('ov_week')), bars(o.last7d.byDay)),
      h('div', { class: 'card' }, h('h3', null, t('ov_byProvider')),
        provs.length ? provs.map(([id, v]) => h('div', { class: 'hrow' },
          h('span', null, id), h('div', { class: 'hbar' }, h('i', { style: `width:${(v.requests / maxReq) * 100}%` })), h('b', null, fmtInt(v.requests))))
          : h('p', { class: 'muted' }, t('ov_noTraffic')))),
    h('div', { class: 'card' }, h('h3', null, t('ov_quick')),
      h('label', { class: 'lbl' }, t('ov_endpoint')), copyBox(`${baseUrl()}/v1`),
      h('label', { class: 'lbl' }, t('ov_anthropic')), copyBox(baseUrl()),
      h('pre', { class: 'code' }, curl),
      h('p', { class: 'muted' }, `${t('ov_rea')} : `, h('span', { class: `badge ${o.duality.ok ? 'ok' : 'err'}` }, o.duality.ok ? t('ov_reaOk') : t('ov_reaBad')),
        ` · ${fmtInt(o.duality.exchanges ?? 0)} ${t('ov_exchanges')} · v${o.version} · ${fmtDuration(o.uptimeSec)}`)),
    h('div', { class: 'card' }, h('h3', null, icon('flame'), ' ', t('ov_live')),
      h('div', { class: 'table-wrap' }, h('table', null, live))),
    h('div', { class: 'card' }, h('h3', null, t('ov_providers')),
      h('div', { class: 'chips' }, o.providers.map((p) => h('a', { class: 'chip', href: '#/providers' }, p.name, ' ', statusBadge(p.status))))));
}
