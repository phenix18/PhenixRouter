// Copyright (c) 2026 Fido-labs —kcw—
// PhenixRouter — application du tableau de bord (SPA à routes par hash, sans dépendance).
import { h, icon, logoSvg, toast } from './js/dom.js';
import { t, lang, setLang } from './js/i18n.js';
import { api, setUnauthorizedHandler } from './js/api.js';

const ROUTES = [
  ['overview', 'dashboard', 'nav_overview'], ['models', 'cpu', 'nav_models'], ['providers', 'plug', 'nav_providers'],
  ['combos', 'shuffle', 'nav_combos'], ['keys', 'key', 'nav_keys'], ['playground', 'terminal', 'nav_playground'],
  ['logs', 'list', 'nav_logs'], ['settings', 'gear', 'nav_settings'],
];
const VIEWS = {
  overview: () => import('./js/views/overview.js'), models: () => import('./js/views/models.js'), providers: () => import('./js/views/providers.js'),
  combos: () => import('./js/views/combos.js'), keys: () => import('./js/views/keys.js'), playground: () => import('./js/views/playground.js'),
  logs: () => import('./js/views/logs.js'), settings: () => import('./js/views/settings.js'),
};

const root = document.getElementById('root');
let cleanups = [];
let renderToken = 0;

const theme = () => { try { return localStorage.getItem('phx_theme') || 'dark'; } catch { return 'dark'; } };
const applyTheme = (v) => { document.documentElement.dataset.theme = v; try { localStorage.setItem('phx_theme', v); } catch { /* ignore */ } };
applyTheme(theme());
setLang(lang());

function runCleanups() {
  for (const fn of cleanups) { try { fn(); } catch { /* ignore */ } }
  cleanups = [];
}

function loginScreen(message) {
  runCleanups();
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true, 'aria-label': t('password'), autofocus: true });
  const err = h('div', { class: 'notice err', hidden: !message }, message ?? '');
  const form = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    try { await api('/api/login', { method: 'POST', body: { password: pw.value } }); start(); }
    catch (x) { err.hidden = false; err.textContent = `${t('loginFailed')} : ${x.message}`; pw.select(); }
  } },
  h('label', { class: 'lbl' }, t('password'), pw), err,
  h('button', { class: 'btn primary', type: 'submit' }, t('signIn')), h('p', { class: 'muted small' }, t('loginHint')));
  root.replaceChildren(h('main', { class: 'login' }, h('div', { class: 'card' },
    h('div', { class: 'brand' }, logoSvg(), h('span', null, t('appName'))), h('p', { class: 'muted center' }, t('tagline')), form,
    h('p', { class: 'muted small center' }, t('copyright')))));
  pw.focus();
}

async function renderRoute(session) {
  const token = ++renderToken;
  const name = (location.hash.replace(/^#\/?/, '').split('?')[0]) || 'overview';
  const key = VIEWS[name] ? name : 'overview';
  runCleanups();
  const main = root.querySelector('.main');
  if (!main) return;
  for (const a of root.querySelectorAll('.nav a')) a.classList.toggle('active', a.dataset.route === key);
  const page = h('div', { class: 'page' }, h('p', { class: 'muted' }, t('loading')));
  main.replaceChildren(page);
  const ctx = { cleanup: (fn) => { if (token === renderToken) cleanups.push(fn); else fn(); }, rerender: () => start(true), session };
  try {
    const mod = await VIEWS[key]();
    const fresh = h('div', { class: 'page' });
    await mod.render(fresh, ctx);
    if (token !== renderToken) return;
    page.replaceWith(fresh);
    main.scrollTop = 0;
  } catch (e) {
    if (token !== renderToken) return;
    page.replaceChildren(h('div', { class: 'notice err' }, `${t('error')} : ${e.message}`));
  }
}

function shell(session) {
  runCleanups();
  const nav = h('nav', { class: 'nav', 'aria-label': 'Navigation' }, ROUTES.map(([id, ic, label]) =>
    h('a', { href: `#/${id}`, 'data-route': id }, icon(ic), h('span', null, t(label)))));
  const themeBtn = h('button', { class: 'btn sm ghost', type: 'button', title: 'Thème', 'aria-label': 'Thème', onclick: () => applyTheme(theme() === 'dark' ? 'light' : 'dark') }, icon('moon'));
  const langBtn = h('button', { class: 'btn sm ghost', type: 'button', onclick: async () => {
    setLang(lang() === 'fr' ? 'en' : 'fr');
    api('/api/settings', { method: 'PUT', body: { language: lang() } }).catch(() => {});
    start(true);
  } }, lang() === 'fr' ? 'EN' : 'FR');
  const out = h('button', { class: 'btn sm ghost', type: 'button', title: t('signOut'), 'aria-label': t('signOut'), onclick: async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
    loginScreen();
  } }, icon('logout'));
  root.replaceChildren(h('div', { class: 'app' },
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' }, logoSvg(), h('div', null, t('appName'), h('small', null, `v${session.version}`))), nav,
      h('div', { class: 'foot' }, h('div', { class: 'row' }, themeBtn, langBtn, out), h('div', { style: 'margin-top:8px' }, t('copyright')))),
    h('main', { class: 'main', id: 'main' })));
}

async function start() {
  let session;
  try { session = await api('/api/session'); } catch (e) { root.replaceChildren(h('div', { class: 'notice err' }, e.message)); return; }
  document.documentElement.lang = lang();
  if (!session.authenticated) { loginScreen(); return; }
  shell(session);
  await renderRoute(session);
  window.onhashchange = () => renderRoute(session);
}

setUnauthorizedHandler(() => { toast(t('loginFailed'), 'err'); loginScreen(); });
start();
