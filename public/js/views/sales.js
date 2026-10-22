// Copyright (c) 2026 Fido-labs —kcw—
// Vue « Ventes » : boutique de tokens (module optionnel) — réglages, commandes, licences, marge.
import { h, toast, modal, copyBox, fmtTime, confirmDialog } from '../dom.js';
import { t } from '../i18n.js';
import { api } from '../api.js';

const mil = (n) => `${(n / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })} M`;
const usd = (n) => `${(Math.round(n * 100) / 100).toLocaleString()} $`;

export async function render(root) {
  const host = h('div');
  root.append(h('h1', null, t('sales_title')), h('p', { class: 'muted' }, t('sales_sub')), host);

  const load = async () => {
    const d = await api('/api/shop');
    const s = d.settings;
    const st = d.stats;
    const shopUrl = `${location.origin}/shop`;

    const stat = (label, value, sub) => h('div', { class: 'card stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'sub' }, sub) : null);
    const stats = h('div', { class: 'grid stats' },
      stat(t('sales_revenue'), usd(st.revenueUsd), `${st.licenses} ${t('sales_licenses')}`),
      stat(t('sales_sold'), mil(st.tokensSold), `${mil(st.tokensConsumed)} ${t('sales_consumed')}`),
      stat(t('sales_outstanding'), mil(st.tokensOutstanding)),
      stat(t('sales_cost'), usd(st.upstreamCostUsd), `${st.requests} req`),
      stat(t('sales_margin'), usd(st.marginUsd)),
      stat(t('sales_ledger'), st.duality.ok && st.chain.ok ? '✓' : '✗', t('sales_ledgerSub')));

    /* ── Réglages ── */
    const f = {
      enabled: h('input', { type: 'checkbox', checked: s.enabled }),
      brand: h('input', { type: 'text', value: s.brandName, maxlength: 60 }),
      price: h('input', { type: 'number', step: '0.01', min: 0.01, value: s.pricePerMillionUsd }),
      currency: h('select', { value: s.currency }, ['USDT', 'USDC', 'BUSD', 'USD'].map((c) => h('option', { value: c }, c))),
      packs: h('input', { type: 'text', value: s.packs.map((p) => `${p.tokens / 1e6}M=${p.priceUsd}`).join(', ') }),
      custom: h('input', { type: 'checkbox', checked: s.allowCustomAmount }),
      url: h('input', { type: 'url', value: s.publicUrl, placeholder: 'https://boutique.mondomaine.com' }),
      contact: h('input', { type: 'text', value: s.contact, maxlength: 120 }),
      notice: h('input', { type: 'text', value: s.notice, maxlength: 400 }),
      ttl: h('input', { type: 'number', min: 5, value: s.orderTtlMin }),
      validity: h('input', { type: 'number', min: 0, value: s.licenseValidityDays }),
      rate: h('input', { type: 'number', min: 0, value: s.soldKeyRateLimitPerMin }),
      mult: h('input', { type: 'text', value: Object.entries(s.multipliers).map(([k, v]) => `${k}=${v}`).join(', '), placeholder: 'openai/gpt-4o=5, groq/*=1' }),
      remote: h('input', { type: 'checkbox', checked: s.allowRemoteAdmin }),
      manual: h('input', { type: 'checkbox', checked: s.methods.manual.enabled }),
      manualLabel: h('input', { type: 'text', value: s.methods.manual.label }),
      manualText: h('textarea', { rows: 3 }, s.methods.manual.instructions),
      bp: h('input', { type: 'checkbox', checked: s.methods.binancepay.enabled }),
      bpKey: h('input', { type: 'password', autocomplete: 'off', placeholder: s.methods.binancepay.hasApiKey ? '•••• (enregistrée)' : 'Binance Pay API key' }),
      bpSecret: h('input', { type: 'password', autocomplete: 'off', placeholder: s.methods.binancepay.hasSecret ? '•••• (enregistré)' : 'Secret' }),
    };
    const parsePacks = (txt) => txt.split(',').map((x) => x.trim()).filter(Boolean).map((x, i) => {
      const m = /^([\d.]+)\s*M?\s*=\s*([\d.]+)$/i.exec(x);
      if (!m) throw new Error(`Pack invalide : « ${x} » (format 1M=3)`);
      return { id: `p${i + 1}`, tokens: Math.round(Number(m[1]) * 1e6), priceUsd: Number(m[2]) };
    });
    const parseMult = (txt) => Object.fromEntries(txt.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
      const [k, v] = x.split('=').map((y) => y.trim());
      if (!k || !(Number(v) > 0)) throw new Error(`Multiplicateur invalide : « ${x} »`);
      return [k, Number(v)];
    }));
    const row = (label, el, hint) => h('label', { class: 'lbl' }, label, el, hint ? h('small', { class: 'muted' }, hint) : null);
    const save = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      try {
        await api('/api/shop', { method: 'PUT', body: {
          enabled: f.enabled.checked, brandName: f.brand.value, pricePerMillionUsd: Number(f.price.value), currency: f.currency.value, packs: parsePacks(f.packs.value),
          allowCustomAmount: f.custom.checked, publicUrl: f.url.value.trim(), contact: f.contact.value, notice: f.notice.value, orderTtlMin: Number(f.ttl.value),
          licenseValidityDays: Number(f.validity.value), soldKeyRateLimitPerMin: Number(f.rate.value), multipliers: parseMult(f.mult.value), allowRemoteAdmin: f.remote.checked,
          methods: { manual: { enabled: f.manual.checked, label: f.manualLabel.value, instructions: f.manualText.value },
            binancepay: { enabled: f.bp.checked, ...(f.bpKey.value ? { apiKey: f.bpKey.value } : {}), ...(f.bpSecret.value ? { secret: f.bpSecret.value } : {}) } },
        } });
        toast(t('saved'), 'ok'); load();
      } catch (e) { toast(e.message, 'err'); }
    } }, t('save'));
    const settings = h('div', { class: 'card' }, h('h3', null, t('sales_settings')),
      h('div', { class: 'notice warn small' }, t('sales_warn')),
      h('label', { class: 'switch-row' }, f.enabled, ' ', t('sales_enabled')),
      h('p', null, h('a', { href: '/shop', target: '_blank', rel: 'noopener noreferrer' }, shopUrl)),
      h('div', { class: 'form' },
        row(t('sales_brand'), f.brand), row(t('sales_price'), f.price), row(t('sales_currency'), f.currency), row(t('sales_packs'), f.packs, '1M=3, 5M=15, 10M=30'),
        h('label', null, f.custom, ' ', t('sales_custom')), row(t('sales_publicUrl'), f.url, t('sales_publicUrlHint')), row(t('sales_contact'), f.contact), row(t('sales_notice'), f.notice),
        row(t('sales_ttl'), f.ttl), row(t('sales_validity'), f.validity), row(t('sales_rate'), f.rate), row(t('sales_mult'), f.mult, t('sales_multHint')),
        h('label', null, f.remote, ' ', t('sales_remote')),
        h('h4', null, t('sales_manual')), h('label', null, f.manual, ' ', t('sales_enabled')), row(t('sales_label'), f.manualLabel), row(t('sales_instr'), f.manualText, '{reference} {amount} {currency}'),
        h('h4', null, 'Binance Pay'), h('div', { class: 'notice small' }, t('sales_bpNote')), h('label', null, f.bp, ' ', t('sales_enabled')), row('API key', f.bpKey), row('Secret', f.bpSecret)),
      save);

    /* ── Commandes ── */
    const badge = (x) => h('span', { class: `badge ${{ delivered: 'ok', pending: 'warn', expired: 'err', canceled: 'err', paid: 'info' }[x] ?? ''}` }, x);
    const orders = h('div', { class: 'card flush' }, h('h3', { class: 'pad' }, t('sales_orders')), h('div', { class: 'table-wrap' }, d.orders.length ? h('table', null,
      h('thead', null, h('tr', null, ['', 'Réf.', t('sales_buyer'), 'Tokens', '$', t('sales_method'), ''].map((x) => h('th', null, x)))),
      h('tbody', null, d.orders.map((o) => h('tr', null, h('td', null, badge(o.status)), h('td', { class: 'mono' }, o.reference, h('div', { class: 'muted small' }, fmtTime(o.createdAt))),
        h('td', null, o.contact), h('td', null, mil(o.tokens), o.topup ? ' ↻' : ''), h('td', null, `${o.amountUsd} ${o.currency}`), h('td', null, o.method),
        h('td', null, o.status === 'pending' ? h('div', { class: 'row' },
          h('button', { class: 'btn sm primary', type: 'button', onclick: async () => {
            const txid = h('input', { type: 'text', placeholder: 'TXID / note' });
            const ok = await modal(`${t('sales_confirmPay')} ${o.reference}`, h('div', null, h('p', null, `${o.amountUsd} ${o.currency} — ${mil(o.tokens)}`), txid), { actions: [{ label: t('cancel'), value: false }, { label: t('confirm'), primary: true, value: true }] });
            if (!ok) return;
            try { await api(`/api/shop/orders/${o.id}/confirm`, { method: 'POST', body: { txid: txid.value.trim() || undefined } }); toast(t('sales_delivered'), 'ok'); load(); } catch (e) { toast(e.message, 'err'); }
          } }, t('sales_paid')),
          h('button', { class: 'btn sm', type: 'button', onclick: async () => { try { await api(`/api/shop/orders/${o.id}/cancel`, { method: 'POST' }); load(); } catch (e) { toast(e.message, 'err'); } } }, t('cancel'))) : null))))) : h('p', { class: 'muted pad' }, t('sales_noOrders'))));

    /* ── Licences ── */
    const licenses = h('div', { class: 'card flush' }, h('div', { class: 'row pad' }, h('h3', { style: 'margin:0;flex:1' }, t('sales_licenseList')),
      h('button', { class: 'btn sm primary', type: 'button', onclick: async () => {
        const tok = h('input', { type: 'number', min: 0.001, step: 'any', value: 1 }); const amt = h('input', { type: 'number', min: 0, step: '0.01', value: 0 });
        const who = h('input', { type: 'text', value: 'hors-ligne' }); const key = h('select', null, h('option', { value: '' }, t('sales_newLicense')), d.licenses.map((l) => h('option', { value: l.id }, `${l.name} (${mil(l.balance)})`)));
        const ok = await modal(t('sales_grant'), h('div', { class: 'form' }, h('label', { class: 'lbl' }, t('sales_grantM'), tok), h('label', { class: 'lbl' }, t('sales_grantUsd'), amt), h('label', { class: 'lbl' }, t('sales_buyer'), who), h('label', { class: 'lbl' }, t('sales_target'), key)),
          { actions: [{ label: t('cancel'), value: false }, { label: t('add'), primary: true, value: true }] });
        if (!ok) return;
        try {
          const r = await api('/api/shop/grant', { method: 'POST', body: { tokens: Number(tok.value) * 1e6, amountUsd: Number(amt.value) || 0, contact: who.value, keyId: key.value || null } });
          if (r.order.licenseKey) await modal(t('sales_licenseCreated'), h('div', null, h('p', null, t('sales_keyOnce')), copyBox(r.order.licenseKey)), { actions: [{ label: t('close'), primary: true, value: true }] });
          else toast(t('sales_delivered'), 'ok');
          load();
        } catch (e) { toast(e.message, 'err'); }
      } }, t('sales_grant'))),
    h('div', { class: 'table-wrap' }, d.licenses.length ? h('table', null,
      h('thead', null, h('tr', null, [t('keys_name'), t('sales_buyer'), t('sales_balance'), t('sales_bought'), t('keys_lastUsed'), ''].map((x) => h('th', null, x)))),
      h('tbody', null, d.licenses.map((l) => h('tr', null, h('td', { class: 'mono' }, l.name), h('td', null, l.contact), h('td', null, h('b', null, mil(l.balance))), h('td', null, mil(l.granted)), h('td', null, fmtTime(l.lastUsedAt)),
        h('td', null, h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: l.enabled, onchange: async () => { try { await api(`/api/shop/licenses/${l.id}/toggle`, { method: 'POST' }); load(); } catch (e) { toast(e.message, 'err'); } } }), h('i'))))))) : h('p', { class: 'muted pad' }, t('sales_noLicenses'))));

    host.replaceChildren(stats, h('div', { class: 'grid two', style: 'margin-top:14px' }, settings, h('div', null, orders, h('div', { style: 'height:14px' }), licenses)));
  };
  await load();
}
