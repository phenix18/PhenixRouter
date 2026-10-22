// Copyright (c) 2026 Fido-labs —kcw—
// Page de vente (aucun innerHTML : tout texte dynamique passe par textContent).
const L = {
  fr: {
    sub: 'Tokens API IA prépayés — une clé, compatible OpenAI & Anthropic', buy: 'Acheter des tokens', packs: 'Choisissez un pack', custom: 'Montant libre (millions de tokens)',
    contact: 'Votre contact (e-mail, WhatsApp ou Telegram)', method: 'Moyen de paiement', topup: 'Recharger une licence existante (facultatif : collez la clé)', total: 'Total', order: 'Commander',
    pay: 'Paiement', ref: 'Référence', waiting: 'En attente du paiement…', open: 'Payer avec Binance Pay', delivered: 'Paiement reçu — voici votre licence', expired: 'Commande expirée ou annulée',
    keyOnce: 'Copiez et conservez cette clé : elle ne sera plus affichée au bout de 24 h. Vous pourrez toujours consulter votre solde avec elle.', account: 'Mon compte', check: 'Voir mon solde',
    balance: 'Solde', used: 'Consommé', granted: 'Total acheté', recent: 'Derniers appels', use: 'Utiliser ma licence', pc: 'Sur PC / terminal', mobile: 'Sur mobile (applications compatibles OpenAI)',
    copy: 'Copier', copied: 'Copié', mil: 'M tokens', error: 'Erreur', unavail: 'Boutique indisponible', mobHelp: 'Dans l’application : choisissez « fournisseur OpenAI compatible / personnalisé », puis saisissez :',
    exp: 'Expire le', lic: 'Votre clé de licence', none: 'Aucun appel récent', noMethod: 'Aucun moyen de paiement n’est activé.', notice: 'Information', model: 'Modèle',
  },
  en: {
    sub: 'Prepaid AI API tokens — one key, OpenAI & Anthropic compatible', buy: 'Buy tokens', packs: 'Pick a pack', custom: 'Custom amount (million tokens)',
    contact: 'Your contact (email, WhatsApp or Telegram)', method: 'Payment method', topup: 'Top up an existing license (optional: paste the key)', total: 'Total', order: 'Place order',
    pay: 'Payment', ref: 'Reference', waiting: 'Waiting for payment…', open: 'Pay with Binance Pay', delivered: 'Payment received — here is your license', expired: 'Order expired or canceled',
    keyOnce: 'Copy and keep this key: it will no longer be displayed after 24 h. You can always check your balance with it.', account: 'My account', check: 'Check my balance',
    balance: 'Balance', used: 'Used', granted: 'Total purchased', recent: 'Recent calls', use: 'Use my license', pc: 'On PC / terminal', mobile: 'On mobile (OpenAI-compatible apps)',
    copy: 'Copy', copied: 'Copied', mil: 'M tokens', error: 'Error', unavail: 'Shop unavailable', mobHelp: 'In the app: choose “OpenAI-compatible / custom provider”, then enter:',
    exp: 'Expires', lic: 'Your license key', none: 'No recent calls', noMethod: 'No payment method is enabled.', notice: 'Notice', model: 'Model',
  },
};
let lang = 'fr';
try { const saved = localStorage.getItem('phx_shop_lang'); lang = saved === 'en' || saved === 'fr' ? saved : ((navigator.language || 'fr').slice(0, 2) === 'en' ? 'en' : 'fr'); } catch { /* ignore */ }
const t = (k) => L[lang][k] ?? k;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
async function call(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
  return data;
}
const fmt = (n) => new Intl.NumberFormat(lang).format(Math.round(n));
const mil = (n) => `${(n / 1e6).toLocaleString(lang, { maximumFractionDigits: 2 })} ${t('mil')}`;
function copy(text, btn) { navigator.clipboard?.writeText(text).then(() => { const o = btn.textContent; btn.textContent = t('copied'); setTimeout(() => { btn.textContent = o; }, 1200); }).catch(() => {}); }
const codeBlock = (text) => { const b = h('button', { class: 'btn', type: 'button' }, t('copy')); b.addEventListener('click', () => copy(text, b)); return h('div', { class: 'codewrap' }, h('pre', { class: 'code' }, text), b); };

const app = document.getElementById('app');
let cfg = null; let timer = null;
const base = () => (cfg?.publicUrl || location.origin).replace(/\/+$/, '');

function setupBlocks(key) {
  const u = base();
  return h('div', null,
    h('h3', null, t('pc')),
    codeBlock(`curl ${u}/v1/chat/completions \\\n  -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" \\\n  -d '{"model":"phenix/auto","messages":[{"role":"user","content":"Bonjour"}]}'`),
    codeBlock(`# OpenAI SDK / Codex / Cursor\nexport OPENAI_BASE_URL="${u}/v1"\nexport OPENAI_API_KEY="${key}"\n\n# Claude Code\nexport ANTHROPIC_BASE_URL="${u}"\nexport ANTHROPIC_AUTH_TOKEN="${key}"`),
    h('h3', null, t('mobile')), h('p', { class: 'muted small' }, t('mobHelp')),
    codeBlock(`Base URL : ${u}/v1\nAPI Key  : ${key}\n${t('model')}    : phenix/auto`));
}

function header() {
  const lb = h('button', { class: 'btn', type: 'button', onclick: () => { lang = lang === 'fr' ? 'en' : 'fr'; store.set('phx_shop_lang', lang); render(); } }, lang === 'fr' ? 'EN' : 'FR');
  return h('header', { class: 'top' }, h('img', { src: '/logo-192.png', alt: '' }), h('div', null, h('h1', null, cfg?.brandName ?? 'PhenixRouter'), h('small', null, t('sub'))), h('div', { class: 'sp' }), lb);
}

function buyCard() {
  let packId = cfg.packs[0]?.id ?? null; let customM = '';
  const contact = h('input', { type: 'text', maxlength: 120, autocomplete: 'email', placeholder: 'ex. nom@mail.com / +226…' });
  const topup = h('input', { type: 'text', placeholder: 'phx-…', autocomplete: 'off', spellcheck: 'false' });
  const method = h('select', null, cfg.methods.map((m) => h('option', { value: m.id }, m.label)));
  const total = h('div', { class: 'total' });
  const err = h('div');
  const packsEl = h('div', { class: 'packs' });
  const price = () => (customM ? Number(customM) * cfg.pricePerMillionUsd : (cfg.packs.find((p) => p.id === packId)?.priceUsd ?? 0));
  const paint = () => {
    packsEl.replaceChildren(...cfg.packs.map((p) => {
      const b = h('button', { class: 'pack', type: 'button', 'aria-pressed': String(!customM && packId === p.id) }, h('b', null, mil(p.tokens)), h('span', null, `${p.priceUsd} ${cfg.currency}`));
      b.addEventListener('click', () => { packId = p.id; customM = ''; custom.value = ''; paint(); });
      return b;
    }));
    total.textContent = `${t('total')} : ${(Math.round(price() * 100) / 100).toLocaleString(lang)} ${cfg.currency}`;
  };
  const custom = h('input', { type: 'number', min: cfg.minMillions, max: cfg.maxMillions, step: 'any', inputmode: 'decimal', placeholder: `${cfg.minMillions} – ${cfg.maxMillions}` });
  custom.addEventListener('input', () => { customM = custom.value; paint(); });
  const go = h('button', { class: 'btn primary', type: 'button' }, t('order'));
  go.addEventListener('click', async () => {
    err.replaceChildren(); go.disabled = true;
    try {
      const body = { contact: contact.value.trim(), method: method.value, ...(topup.value.trim() ? { licenseKey: topup.value.trim() } : {}), ...(customM ? { millions: Number(customM) } : { packId }) };
      const { order, token } = await call('/shop-api/orders', { method: 'POST', body });
      store.set('phx_order', JSON.stringify({ id: order.id, token }));
      showOrder(order.id, token);
    } catch (e) { err.replaceChildren(h('div', { class: 'notice err' }, e.message)); } finally { go.disabled = false; }
  });
  paint();
  return h('section', { class: 'card' }, h('h2', null, t('buy')),
    cfg.notice ? h('div', { class: 'notice warn' }, cfg.notice) : null,
    cfg.methods.length ? [h('label', { class: 'lbl' }, t('packs')), packsEl,
      cfg.allowCustomAmount ? [h('label', { class: 'lbl' }, t('custom')), custom] : null,
      h('label', { class: 'lbl' }, t('contact')), contact, h('label', { class: 'lbl' }, t('method')), method,
      h('label', { class: 'lbl' }, t('topup')), topup, total, err, go] : h('div', { class: 'notice err' }, t('noMethod')));
}

const orderHost = h('div');
async function showOrder(id, token) {
  clearTimeout(timer);
  let o;
  try { ({ order: o } = await call(`/shop-api/orders/${id}?t=${encodeURIComponent(token)}`)); } catch (e) { store.del('phx_order'); orderHost.replaceChildren(h('div', { class: 'notice err' }, e.message)); return; }
  const card = h('section', { class: 'card' }, h('h2', null, `${t('pay')} — ${o.reference}`));
  if (o.status === 'delivered') {
    store.del('phx_order');
    if (o.licenseKey) {
      store.set('phx_license', o.licenseKey);
      card.append(h('div', { class: 'notice ok' }, t('delivered'), ` (${mil(o.tokens)})`), h('label', { class: 'lbl' }, t('lic')), h('div', { class: 'key' }, o.licenseKey), codeBlock(o.licenseKey), h('div', { class: 'notice warn' }, t('keyOnce')), setupBlocks(o.licenseKey));
      loadAccount(o.licenseKey);
    } else card.append(h('div', { class: 'notice ok' }, t('delivered')));
  } else if (o.status === 'pending') {
    card.append(h('p', null, `${mil(o.tokens)} — `, h('b', null, `${o.amountUsd} ${o.currency}`)));
    if (o.method === 'manual') card.append(h('pre', { class: 'code' }, o.payment.instructions));
    else if (o.payment.checkoutUrl) card.append(h('a', { class: 'btn primary', href: o.payment.checkoutUrl, target: '_blank', rel: 'noopener noreferrer' }, t('open')), o.payment.deeplink ? h('a', { class: 'btn', href: o.payment.deeplink }, 'App Binance') : null);
    card.append(h('div', { class: 'notice' }, t('waiting')));
    timer = setTimeout(() => showOrder(id, token), 4000);
  } else { store.del('phx_order'); card.append(h('div', { class: 'notice err' }, t('expired'))); }
  orderHost.replaceChildren(card);
}

const accHost = h('div');
async function loadAccount(key) {
  try {
    const { account: a } = await call('/shop-api/account', { method: 'POST', body: { licenseKey: key } });
    store.set('phx_license', key);
    const pct = a.granted ? Math.max(0, Math.min(100, (a.balance / a.granted) * 100)) : 0;
    accHost.replaceChildren(h('section', { class: 'card' }, h('h2', null, t('account')),
      h('div', { class: 'total' }, `${t('balance')} : ${mil(a.balance)}`), h('div', { class: 'meter' }, h('i', { style: `width:${pct}%` })),
      h('p', { class: 'muted small' }, `${t('granted')} : ${fmt(a.granted)} · ${t('used')} : ${fmt(a.used)}${a.expiresAt ? ` · ${t('exp')} ${new Date(a.expiresAt).toLocaleDateString(lang)}` : ''}`),
      h('h3', null, t('recent')),
      a.recent.length ? h('table', null, h('tbody', null, a.recent.map((r) => h('tr', null, h('td', null, new Date(r.ts).toLocaleString(lang)), h('td', null, r.model ?? ''), h('td', null, r.cached ? '≈0' : fmt(r.tokens)), h('td', null, r.status))))) : h('p', { class: 'muted' }, t('none')),
      h('h3', null, t('use')), setupBlocks(key)));
  } catch (e) { store.del('phx_license'); accHost.replaceChildren(h('div', { class: 'notice err' }, e.message)); }
}

function accountForm() {
  const k = h('input', { type: 'password', placeholder: 'phx-…', autocomplete: 'off', spellcheck: 'false' });
  const b = h('button', { class: 'btn', type: 'button', onclick: () => { if (k.value.trim()) loadAccount(k.value.trim()); } }, t('check'));
  return h('section', { class: 'card' }, h('h2', null, t('account')), h('div', { class: 'row' }, h('div', { style: 'flex:1;min-width:200px' }, k), b));
}

async function render() {
  document.documentElement.lang = lang;
  try { cfg = await call('/shop-api/config'); } catch (e) { app.replaceChildren(h('div', { class: 'wrap' }, h('div', { class: 'notice err' }, `${t('unavail')} — ${e.message}`))); return; }
  document.title = `${cfg.brandName} — ${t('buy')}`;
  app.replaceChildren(h('div', { class: 'wrap' }, header(), buyCard(), orderHost, accountForm(), accHost,
    h('footer', null, cfg.contact ? `${cfg.contact} · ` : '', 'PhenixRouter © 2026 Fido-labs —kcw—')));
  const saved = store.get('phx_order');
  if (saved) { try { const { id, token } = JSON.parse(saved); showOrder(id, token); } catch { store.del('phx_order'); } }
  const lic = store.get('phx_license');
  if (lic) loadAccount(lic);
}
render();
