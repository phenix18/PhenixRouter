#!/usr/bin/env node
// Copyright (c) 2026 Fido-labs —kcw—
// PhenixRouter — lanceur en ligne de commande.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { join, dirname } from 'node:path';
import { importLegacyConfig } from '../src/core/legacy.js';
import { toolPaths, applyTool, removeTool, manualSnippets, TOOLS } from '../src/core/clitools.js';
import { BRAND, VERSION, resolveDataDir } from '../src/config.js';
import { start } from '../src/server.js';
import { Gateway } from '../src/gateway.js';
import { PROVIDERS } from '../src/providers/registry.js';
import { manageService } from '../src/core/service.js';
import { runDoctor } from '../src/core/doctor.js';
import { createBackup, restoreBackup } from '../src/core/backup.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c('1', s);
const dim = (s) => c('2', s);
const orange = (s) => c('38;5;208', s);
const green = (s) => c('32', s);
const red = (s) => c('31', s);

const HELP = `
${bold(`${BRAND.name} ${VERSION}`)} — ${BRAND.tagline}
${dim(BRAND.copyright)}

${bold('Utilisation')}
  phenixrouter [start] [options]     Démarre le serveur et ouvre le tableau de bord
  phenixrouter keys list             Liste les clés API clientes
  phenixrouter keys create <nom>     Crée une clé API (affichée une seule fois)
  phenixrouter keys revoke <id>      Supprime une clé API
  phenixrouter providers             Liste les fournisseurs (gratuits et payants) pris en charge
  phenixrouter info                  Affiche les adresses (Base URL), les clés et comment se connecter
  phenixrouter connect <fournisseur> <clé>   Ajoute une clé fournisseur sans le tableau de bord (ex. groq gsk_…)
  phenixrouter check                 Vérifie que Claude Code / OpenCode / Droid pointent vers la bonne adresse avec une clé valide
  phenixrouter test [modèle]         Envoie une vraie requête de test et explique l'échec éventuel
  phenixrouter list                  Liste vos connexions (clés) et leur état
  phenixrouter models [--all] [--free] [--code]   Liste les modèles détectés (gratuit / payant, prix indicatif)
  phenixrouter coding [--all]        Meilleurs modèles GRATUITS pour coder (Claude, GPT, GLM, Qwen, DeepSeek, Kimi…) par famille
  phenixrouter status                Vérifie si le serveur tourne (/health)
  phenixrouter usage                 Requêtes, tokens et coût estimé (24 h / 7 j)
  phenixrouter import <config.json>  Importe les comptes d'un config.json « phenixRouter v3 » (Python)
  phenixrouter setup <outil> [--key K] [--write|--remove]   Configure un outil : claude codex opencode cline droid copilot | openai continue aider gemini | list
  phenixrouter service install|uninstall|status   Service permanent (systemd / launchd / tâche Windows, sans admin)
  phenixrouter backup <fichier> [--password P]    Sauvegarde chiffrée (mot de passe aussi via PHENIX_BACKUP_PASSWORD)
  phenixrouter restore <fichier> [--password P]   Restaure une sauvegarde (serveur arrêté)
  phenixrouter doctor [--port N]     Diagnostic de l'environnement (Node, port, clés, réseau)
  phenixrouter reset-password [mdp]  Définit un nouveau mot de passe du tableau de bord
  phenixrouter --version | --help

${bold('Options de démarrage')}
  -p, --port <n>        Port (défaut ${BRAND.defaultPort}, env PORT) ; s'il est occupé, les 9 suivants sont essayés
      --strict-port     Échoue si le port demandé est occupé (pas de bascule)
      --host <addr>     Adresse d'écoute (défaut 127.0.0.1 ; 0.0.0.0 pour exposer)
      --data-dir <dir>  Dossier de données (défaut ~/.${BRAND.slug}, env PHENIX_DATA_DIR)
      --no-browser      N'ouvre pas le navigateur
      --name/--base-url/--account-id   (connect) nom, URL de base, identifiant de compte du fournisseur
      --all             (models) inclut aussi les modèles dont le fournisseur n'est pas connecté
      --key <clé>       (setup) clé API cliente à écrire dans la configuration (sinon PHENIX_API_KEY)
      --write           (setup) écrit la configuration de l'outil (fusion non destructive, sauvegarde .bak)
      --remove          (setup) retire la configuration PhenixRouter de l'outil

${bold('Variables d\'environnement utiles')}
  GROQ_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY, CEREBRAS_API_KEY, MISTRAL_API_KEY,
  OPENAI_API_KEY, ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, XAI_API_KEY … (fournisseurs payants, facultatifs)
  NVIDIA_API_KEY, GITHUB_MODELS_TOKEN, HF_TOKEN, SAMBANOVA_API_KEY, TOGETHER_API_KEY, COHERE_API_KEY,
  CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID …  (plusieurs clés : séparées par des virgules)
  PHENIX_PASSWORD (mot de passe initial), PHENIX_API_KEY (clé cliente fixe, séparées par virgules)
`;

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.flags.help = true;
    else if (a === '-v' || a === '--version') out.flags.version = true;
    else if (a === '-p' || a === '--port') out.flags.port = argv[++i];
    else if (a.startsWith('--port=')) out.flags.port = a.slice(7);
    else if (a === '--host') out.flags.host = argv[++i];
    else if (a.startsWith('--host=')) out.flags.host = a.slice(7);
    else if (a === '--data-dir') out.flags.dataDir = argv[++i];
    else if (a.startsWith('--data-dir=')) out.flags.dataDir = a.slice(11);
    else if (a === '--no-browser') out.flags.noBrowser = true;
    else if (a === '--strict-port') out.flags.strictPort = true;
    else if (a === '--free') out.flags.free = true;
    else if (a === '--code') out.flags.code = true;
    else if (a === '--all') out.flags.all = true;
    else if (a === '--write') out.flags.write = true;
    else if (a === '--password') out.flags.password = argv[++i];
    else if (a.startsWith('--password=')) out.flags.password = a.slice(11);
    else if (a === '--name') out.flags.name = argv[++i];
    else if (a === '--base-url') out.flags.baseUrl = argv[++i];
    else if (a === '--account-id') out.flags.accountId = argv[++i];
    else if (a === '--key') out.flags.key = argv[++i];
    else if (a.startsWith('--key=')) out.flags.key = a.slice(6);
    else out._.push(a);
  }
  return out;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
    p.on('error', () => {});
    p.unref();
  } catch { /* pas de navigateur disponible */ }
}

/** Port à contacter : --port, sinon PORT, sinon le port réellement pris par le serveur (fichier « port »), sinon le défaut. */
function portOf(flags) {
  if (flags.port ?? process.env.PORT) return Number(flags.port ?? process.env.PORT);
  try { const n = Number(readFileSync(join(resolveDataDir(flags.dataDir), 'port'), 'utf8')); if (Number.isInteger(n) && n > 0) return n; } catch { /* ignore */ }
  return BRAND.defaultPort;
}

async function serverRunning(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(600) });
    return r.ok;
  } catch {
    return false;
  }
}

async function cmdStart(flags) {
  const port = Number(flags.port ?? process.env.PORT ?? BRAND.defaultPort);
  const host = flags.host ?? process.env.HOST ?? '127.0.0.1';
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port invalide');
  const app = await start({ port, host, dataDir: flags.dataDir, portFallback: flags.strictPort || port === 0 ? 0 : 9 });
  if (app.port !== port && port !== 0) console.log(`\n  ${orange('ℹ')} Le port ${port} est occupé : ${BRAND.name} utilise le port ${bold(String(app.port))}.\n    ${dim('Outils déjà configurés ? Mettez-les à jour : phenixrouter setup claude --write (idem opencode) · vérification : phenixrouter check')}`);

  console.log(`\n${orange(bold(`  🔥 ${BRAND.name}`))} ${dim(`v${VERSION}`)}  ${dim('—')}  ${BRAND.tagline}`);
  console.log(dim(`  ${BRAND.copyright}\n`));
  console.log(`  ${bold('Tableau de bord')}   ${green(app.url)}`);
  console.log(`  ${bold('Base URL (OpenAI)')}  ${green(`${app.url}/v1`)}   ${dim('— Cursor, Codex, SDK OpenAI, applications mobiles')}`);
  console.log(`  ${bold('Base URL (Claude)')}  ${green(app.url)}   ${dim('— Claude Code : ANTHROPIC_BASE_URL (sans /v1)')}`);
  if (host === '0.0.0.0' || host === '::') for (const ip of lanAddresses()) console.log(`  ${bold('Sur le réseau')}      ${green(`http://${ip}:${app.port}/v1`)}   ${dim('— téléphone / autre PC du même Wi‑Fi')}`);
  console.log(`  ${bold('Données')}           ${dim(resolveDataDir(flags.dataDir))}`);
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    console.log(`\n  ${red('⚠')}  Le serveur écoute sur ${host} : protégez-le (mot de passe fort, proxy HTTPS, pare-feu).`);
  }
  if (app.creds.firstRun) {
    console.log(`\n  ${bold('Premier lancement — notez ces identifiants (affichés une seule fois) :')}`);
    console.log(`  ${bold('Mot de passe du tableau de bord')} : ${orange(app.creds.password)}${app.creds.passwordFromEnv ? dim('  (PHENIX_PASSWORD)') : ''}`);
    if (app.creds.apiKey) console.log(`  ${bold('Clé API « default »')}             : ${orange(app.creds.apiKey)}`);
    if (app.creds.credentialsFile) console.log(`  ${dim(`Copie conservée dans ${app.creds.credentialsFile} (supprimez-la après lecture).`)}`);
  } else {
    const f = join(resolveDataDir(flags.dataDir), 'credentials.txt');
    if (existsSync(f)) console.log(`\n  ${bold('Identifiants')} : ${dim(f)}`);
    else console.log(`\n  ${dim('Mot de passe oublié : phenixrouter reset-password · Nouvelle clé API : phenixrouter keys create <nom> · Aide : phenixrouter info')}`);
  }
  if (!app.gw.connections().some((c) => !c.implicit && c._key && c.enabled !== false) && !PROVIDERS.some((p) => p.keyEnv && process.env[p.keyEnv])) {
    console.log(`\n  ${red('!')} Aucune clé fournisseur : ajoutez-en une gratuite (Groq, Gemini, OpenRouter…) dans « Fournisseurs » ou : ${bold('phenixrouter connect groq <clé>')}`);
  }
  const configured = PROVIDERS.filter((p) => p.keyEnv && process.env[p.keyEnv]).map((p) => p.name);
  if (configured.length) console.log(`\n  ${green('✓')} Clés détectées dans l'environnement : ${configured.join(', ')}`);
  console.log(`\n  ${dim('Pollinations (sans clé) est un secours communautaire, parfois indisponible : pour une API fiable, ajoutez une clé gratuite (Groq, Gemini, OpenRouter…).')}`);
  console.log(`  ${dim('Ctrl+C pour arrêter.\n')}`);

  if (!flags.noBrowser && process.stdout.isTTY && !process.env.CI && !process.env.PHENIX_NO_BROWSER) openBrowser(app.url);

  const stop = async () => {
    console.log(dim('\n  Arrêt en cours…'));
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

/** Appel à l'API d'administration du serveur local (jeton admin.token) ; null si le serveur ne tourne pas. */
async function viaServer(flags, method, path, body) {
  const port = portOf(flags);
  if (!(await serverRunning(port))) return null;
  let token;
  try { token = readFileSync(join(resolveDataDir(flags.dataDir), 'admin.token'), 'utf8').trim(); } catch { return null; }
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', 'x-phenix-local-admin': token }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message ?? j?.error ?? `HTTP ${res.status}`);
  return j;
}

/** Crée une clé API cliente : via le serveur en marche, sinon directement dans la base. */
async function createClientKey(flags, name) {
  const live = await viaServer(flags, 'POST', '/api/keys', { name }).catch(() => null);
  if (live?.key) return live.key;
  let key;
  await mutating(flags, (gw) => { ({ key } = gw.createApiKey(name)); gw.store.flush(); });
  return key;
}

async function mutating(flags, fn) {
  const port = portOf(flags);
  if (await serverRunning(port)) {
    console.error(red('Le serveur tourne : utilisez le tableau de bord (ou arrêtez-le) pour modifier la configuration.'));
    process.exit(1);
  }
  const gw = new Gateway({ dataDir: flags.dataDir });
  try { await fn(gw); } finally { gw.close(); }
}


const fmtPrice = (m) => (m.tier !== 'paid' ? green('gratuit') : m.price?.known ? `~${m.price.in}/${m.price.out} $/M` : 'payant');

async function cmdList(flags) {
  const gw = new Gateway({ dataDir: flags.dataDir });
  try {
    const conns = gw.connections();
    if (!conns.length) console.log('Aucune connexion. Ajoutez des clés dans le tableau de bord ou via variables d\'environnement.');
    for (const cn of conns) {
      const p = PROVIDERS.find((x) => x.id === cn.provider);
      const key = cn._key ? `…${cn._key.slice(-4)}` : dim('(sans clé)');
      console.log(`  ${bold(cn.provider.padEnd(11))} ${String(cn.name).padEnd(28)} ${key.padEnd(8)} ${p?.tier === 'paid' ? red('payant ') : green('gratuit')}  prio ${cn.priority ?? 5}  ${cn.enabled ? green('actif') : red('désactivé')}`);
    }
  } finally { gw.close(); }
}

async function cmdModels(flags) {
  const gw = new Gateway({ dataDir: flags.dataDir });
  try {
    await gw.catalog.refresh({ force: true });
    const list = gw.catalog.list().filter((m) => (flags.all || m.status === 'ready') && (!flags.free || m.tier !== 'paid') && (!flags.code || m.codingScore != null));
    console.log(`${list.length} modèle(s)${flags.all ? '' : ' prêt(s)'} :`);
    for (const m of list) console.log(`  ${m.id.padEnd(60)} ${fmtPrice(m).padEnd(24)} ${dim(m.tags.join(','))}`);
    if (!list.length) console.log(dim('  Aucun modèle prêt : ajoutez une clé, ou utilisez --all pour tout voir.'));
  } finally { gw.close(); }
}

/** Vérifie la configuration réelle des outils (Claude Code, OpenCode, Cline, Droid) : adresse joignable ? clé acceptée ? */
async function cmdCheck(flags) {
  const port = portOf(flags);
  const running = await serverRunning(port);
  console.log(`\n${bold('Serveur')} : ${running ? green(`en ligne sur le port ${port}`) : red(`arrêté (port ${port}) — lancez : phenixrouter start`)}\n`);
  const found = [];
  const readJ = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
  const files = Object.fromEntries(toolPaths().map((t) => [t.id, t.file]));
  const cc = readJ(files.claude)?.env;
  if (cc?.ANTHROPIC_BASE_URL) found.push({ tool: 'Claude Code', url: cc.ANTHROPIC_BASE_URL.replace(/\/v1\/?$/, ''), key: cc.ANTHROPIC_AUTH_TOKEN ?? cc.ANTHROPIC_API_KEY });
  const oc = readJ(files.opencode)?.provider?.phenix?.options;
  if (oc?.baseURL) found.push({ tool: 'OpenCode', url: oc.baseURL.replace(/\/v1\/?$/, ''), key: oc.apiKey });
  const dr = readJ(files.droid)?.customModels?.find((m) => String(m.id).startsWith('custom:'));
  if (dr?.baseUrl) found.push({ tool: 'Droid', url: dr.baseUrl.replace(/\/v1\/?$/, ''), key: dr.apiKey });
  if (!found.length) { console.log(dim('  Aucun outil configuré par PhenixRouter. Faites : phenixrouter setup claude --write  (ou opencode)\n')); return; }
  let bad = 0;
  for (const f of found) {
    let verdict;
    try {
      const res = await fetch(`${f.url}/v1/models`, { headers: { authorization: `Bearer ${f.key ?? ''}` }, signal: AbortSignal.timeout(3000) });
      if (res.ok) verdict = green('✓ adresse et clé valides');
      else if (res.status === 401) { verdict = red('✗ clé refusée (supprimée ou fausse) → phenixrouter setup <outil> --write'); bad += 1; }
      else { verdict = red(`✗ HTTP ${res.status}`); bad += 1; }
    } catch (e) {
      bad += 1;
      verdict = red(`✗ adresse injoignable (${e?.cause?.code ?? e.message}) → le serveur n'écoute pas sur ${f.url} ; relancez « phenixrouter setup <outil> --write » pour mettre à jour le port`);
    }
    console.log(`  ${bold(f.tool.padEnd(12))} ${f.url}  ${f.key ? dim(`${f.key.slice(0, 8)}…`) : red('(pas de clé)')}\n    ${verdict}`);
  }
  console.log(bad ? `\n  ${red('!')} ${bad} problème(s) à corriger.\n` : `\n  ${green('Tout est cohérent.')}\n`);
  if (bad) process.exitCode = 1;
}

async function cmdCoding(flags) {
  const gw = new Gateway({ dataDir: flags.dataDir });
  try {
    await gw.catalog.refresh({ force: true }).catch(() => {});
    const rows = gw.catalog.list().filter((m) => m.codingScore != null && (flags.paid || m.tier !== 'paid') && (flags.all || m.status === 'ready'))
      .sort((a, b) => b.codingScore - a.codingScore);
    console.log(`\n${bold('Modèles gratuits adaptés au codage')} ${dim('(appel d’outils requis ; classés par aptitude)')}\n`);
    if (!rows.length) {
      console.log(dim('  Aucun modèle prêt. Ajoutez une clé gratuite : phenixrouter connect groq <clé> (ou openrouter, gemini, cerebras, mistral…)'));
      console.log(dim('  Voir tout, même sans clé : phenixrouter coding --all\n'));
      return;
    }
    const byFamily = new Map();
    for (const m of rows) byFamily.set(m.family, [...(byFamily.get(m.family) ?? []), m]);
    for (const [fam, list] of byFamily) {
      console.log(`  ${orange(fam.toUpperCase())}`);
      for (const m of list.slice(0, 6)) console.log(`    ${m.id.padEnd(58)} ${String(m.codingScore).padStart(3)}  ${m.status === 'ready' ? green('prêt') : dim('à connecter')}  ${dim(m.tags.filter((x) => x !== 'chat').join(','))}`);
    }
    const best = rows.find((m) => m.status === 'ready' && !PROVIDERS.find((p) => p.id === m.provider)?.experimental) ?? rows.find((m) => m.status === 'ready');
    console.log(`\n  ${bold('Recommandé')} : ${best ? green(best.id) : dim('—')}   ${dim('· alias dynamique : phenix/code (meilleur modèle gratuit de codage prêt)')}\n`);
  } finally { gw.close(); }
}

function lanAddresses() {
  return Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}

async function cmdInfo(flags) {
  const port = portOf(flags);
  const gw = new Gateway({ dataDir: flags.dataDir });
  try {
    const base = `http://127.0.0.1:${port}`;
    const running = await serverRunning(port);
    console.log(`\n${bold(BRAND.name)} ${dim(`v${VERSION}`)}   ${running ? green('● en ligne') : red('○ arrêté — lancez : phenixrouter start')}\n`);
    console.log(`  ${bold('Tableau de bord')}        ${green(base)}`);
    console.log(`  ${bold('Base URL OpenAI')}        ${green(`${base}/v1`)}   ${dim('(Cursor, Codex, SDK, apps mobiles)')}`);
    console.log(`  ${bold('Base URL Claude Code')}   ${green(base)}   ${dim('(ANTHROPIC_BASE_URL, sans /v1)')}`);
    for (const ip of lanAddresses()) console.log(`  ${bold('Réseau local')}           ${dim(`http://${ip}:${port}/v1  (démarrez avec --host 0.0.0.0)`)}`);
    const keys = gw.listApiKeys().filter((k) => !k.sold);
    console.log(`\n  ${bold('Clés API clientes')} ${dim('(la valeur complète n’est affichée qu’à la création)')}`);
    if (!keys.length) console.log('    aucune — créez-en une : phenixrouter keys create <nom>');
    for (const k of keys) console.log(`    ${k.prefix}…  ${k.enabled ? green('actif') : red('désactivé')}  ${k.name}`);
    const f = join(resolveDataDir(flags.dataDir), 'credentials.txt');
    console.log(`\n  ${bold('Identifiants du premier lancement')} : ${existsSync(f) ? f : dim('fichier supprimé — phenixrouter reset-password / keys create')}`);
    const conns = gw.connections().filter((x) => !x.implicit && x._key && x.enabled !== false);
    console.log(`  ${bold('Clés fournisseurs')} : ${conns.length ? conns.map((x) => x.name).join(', ') : red('aucune')} ${conns.length ? '' : dim('→ phenixrouter connect groq <clé>')}`);
    console.log(`\n  ${dim('Tester : phenixrouter test    ·    Diagnostic : phenixrouter doctor')}\n`);
  } finally { gw.close(); }
}

async function cmdConnect(flags, provider, key) {
  const { getProvider } = await import('../src/providers/registry.js');
  const p = getProvider(provider);
  if (!p) throw new Error(`Fournisseur inconnu : « ${provider ?? ''} » (voir : phenixrouter providers)`);
  if (!key && !p.keyless) throw new Error(`Utilisation : phenixrouter connect ${p.id} <clé API>`);
  await mutating(flags, async (gw) => {
    gw.addConnection({ provider: p.id, name: flags.name, apiKey: key, baseUrl: flags.baseUrl, extra: flags.accountId ? { accountId: flags.accountId } : undefined });
    gw.store.flush();
    console.log(`${green('✓')} ${p.name} connecté. ${dim('Vérifiez avec : phenixrouter test')}`);
  });
}

async function cmdTest(flags, model) {
  const { runChat } = await import('../src/core/chat.js');
  const gw = new Gateway({ dataDir: flags.dataDir });
  try {
    await gw.catalog.refresh({ force: true }).catch(() => {});
    const target = model || 'phenix/auto';
    process.stdout.write(`Test « ${target} » … `);
    const t0 = Date.now();
    const out = await runChat(gw, { model: target, messages: [{ role: 'user', content: 'Réponds uniquement : OK' }], max_tokens: 16 }, { client: 'cli-test', route: 'chat', requestedModel: target });
    const j = out.json ?? out;
    console.log(`${green('✓ opérationnel')} ${dim(`(${Date.now() - t0} ms, via ${out.served ?? j.model ?? '?'})`)}\n  Réponse : ${String(j.choices?.[0]?.message?.content ?? '').slice(0, 80)}`);
  } catch (e) {
    console.log(`${red('✗ échec')}\n  ${e.message}`);
    for (const a of e.attempts ?? []) console.log(dim(`   - ${a.provider}${a.model ? `/${a.model}` : ''} : ${a.skipped ? `ignoré (${a.skipped})` : `${a.status ?? a.kind} ${a.message ?? ''}`}`));
    process.exitCode = 1;
  } finally { gw.close(); }
}

async function cmdStatus(flags) {
  const port = portOf(flags);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2500) });
    const j = await r.json();
    console.log(`${green('✓ En ligne')}  ${j.name} v${j.version} — ${j.modelsReady} modèle(s) prêt(s), mode de coût « ${j.costMode} », uptime ${j.uptimeSec}s`);
  } catch {
    console.log(`${red('✗ Hors ligne')} sur le port ${port} — lancez : phenixrouter start`);
    process.exitCode = 1;
  }
}

async function cmdUsage(flags) {
  const gw = new Gateway({ dataDir: flags.dataDir });
  try {
    for (const [label, ms] of [['24 h', 86400e3], ['7 jours', 7 * 86400e3]]) {
      const t = gw.ledger.summary({ sinceMs: ms }).total;
      console.log(`  ${bold(label.padEnd(8))} ${String(t.requests).padStart(6)} requêtes · ${t.tokensIn}/${t.tokensOut} tokens · ${t.cached} en cache · coût estimé ${t.costUsd.toFixed(4)} $`);
    }
    const sp = gw.spend();
    console.log(`  ${dim(`Aujourd'hui ${sp.day.toFixed(4)} $ · ce mois ${sp.month.toFixed(4)} $ · mode « ${gw.settings().costMode} »`)}`);
  } finally { gw.close(); }
}

async function cmdImport(flags, file) {
  if (!file) throw new Error('Usage : phenixrouter import <config.json>');
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  await mutating(flags, (gw) => {
    const out = importLegacyConfig(gw, cfg);
    gw.store.flush();
    console.log(`${green('✓')} ${out.imported} compte(s) importé(s).`);
    for (const s of out.skipped) console.log(`  ${dim('ignoré')} ${s.id} — ${s.reason}`);
    console.log(dim('  (la clé admin du fichier n\'est pas reprise : utilisez le mot de passe PhenixRouter)'));
  });
}

async function cmdSetup(flags, tool = 'claude') {
  const port = portOf(flags);
  const base = `http://127.0.0.1:${port}`;
  const key = flags.key || process.env.PHENIX_API_KEY?.split(',')[0] || 'phx-VOTRE_CLE';
  if (tool === 'list') {
    for (const t of toolPaths()) console.log(`  ${bold(t.id.padEnd(9))} ${t.label.padEnd(44)} ${dim(t.file)}${t.exists ? green(' ✓') : ''}`);
    console.log(dim('\n  Autres : openai | continue | aider | gemini (instructions à copier)'));
    return;
  }
  if (TOOLS[tool]) {
    if (flags.remove) {
      const r = removeTool(tool);
      console.log(r.removed ? `${green('✓')} Configuration retirée de ${r.file}` : `Rien à retirer dans ${r.file}`);
      return;
    }
    if (!flags.write) {
      console.log(`${bold(TOOLS[tool].label)} — fichier visé : ${toolPaths().find((x) => x.id === tool).file}`);
      console.log(`Relancez avec ${bold('--write')} pour l’écrire (sauvegarde .bak), ${bold('--key <clé>')} pour la clé API cliente, ${bold('--remove')} pour retirer.`);
      if (TOOLS[tool].note) console.log(dim(TOOLS[tool].note));
      return;
    }
    let useKey = key;
    if (key === 'phx-VOTRE_CLE') {
      // Pas de clé fournie : on en crée une dédiée à cet outil (le serveur peut tourner), plus rien à copier à la main.
      useKey = await createClientKey(flags, tool);
      console.log(`${green('✓')} Clé API « ${tool} » créée et écrite dans la configuration de l'outil.`);
    }
    const r = applyTool(tool, { base, key: useKey });
    console.log(`${green('✓')} Configuration écrite dans ${r.file}${r.backup ? dim(` (ancienne version : ${r.backup})`) : ''}`);
    if (r.note) console.log(dim(r.note));
    return;
  }
  const snippets = manualSnippets({ base, key });
  if (snippets[tool] || tool === 'generic') {
    console.log(bold(`${tool} — à copier :\n`));
    console.log(snippets[tool === 'generic' ? 'openai' : tool]);
    return;
  }
  throw new Error(`Outil inconnu. Choix : ${[...Object.keys(TOOLS), 'openai', 'continue', 'aider', 'gemini'].join(' | ')} (ou « setup list »)`);
}

async function cmdService(flags, sub) {
  if (!['install', 'uninstall', 'status'].includes(sub)) throw new Error('Utilisation : phenixrouter service install|uninstall|status [--port N] [--host ADDR] [--data-dir DIR]');
  const r = manageService(sub, { opts: { port: flags.port, host: flags.host, dataDir: flags.dataDir } });
  if (sub === 'status') { console.log(`Service ${r.platform} : ${bold(r.state)}${r.file ? dim(`  (${r.file})`) : ''}`); return; }
  console.log(`${green('✓')} Service ${sub === 'install' ? 'installé et démarré' : 'retiré'} (${r.platform})${r.file ? dim(` — ${r.file}`) : ''}`);
  for (const n of r.notes) console.log(dim(`  ${n}`));
}

function backupPassword(flags) {
  const p = flags.password ?? process.env.PHENIX_BACKUP_PASSWORD;
  if (!p) throw new Error('Mot de passe requis : --password <mdp> ou variable PHENIX_BACKUP_PASSWORD (10 caractères minimum)');
  return p;
}

async function cmdDoctor(flags) {
  const port = portOf(flags);
  const rows = await runDoctor({ dataDir: resolveDataDir(flags.dataDir), port, host: flags.host ?? '127.0.0.1' });
  const mark = { ok: green('✓'), warn: orange('!'), fail: red('✗') };
  for (const r of rows) console.log(`  ${mark[r.status]} ${bold(r.name.padEnd(22))} ${r.detail}`);
  if (rows.some((r) => r.status === 'fail')) process.exitCode = 1;
}

async function main() {
  const { _: args, flags } = parseArgs(process.argv.slice(2));
  if (flags.help) { console.log(HELP); return; }
  if (flags.version) { console.log(VERSION); return; }
  const [cmd = 'start', sub, arg] = args;

  switch (cmd) {
    case 'start':
      await cmdStart(flags); break;
    case 'providers':
      for (const p of PROVIDERS) {
        const env = p.keyEnv ? dim(`  ${p.keyEnv}`) : dim(p.keyless ? '  (sans clé)' : '');
        console.log(`  ${bold(p.id.padEnd(13))} ${p.tier === 'paid' ? red('payant ') : green('gratuit')} ${p.name}${env}`);
      }
      break;
    case 'list': await cmdList(flags); break;
    case 'models': await cmdModels(flags); break;
    case 'status': await cmdStatus(flags); break;
    case 'info': await cmdInfo(flags); break;
    case 'coding': await cmdCoding(flags); break;
    case 'check': await cmdCheck(flags); break;
    case 'connect': await cmdConnect(flags, sub, arg); break;
    case 'test': await cmdTest(flags, sub); break;
    case 'usage': await cmdUsage(flags); break;
    case 'import': await cmdImport(flags, sub); break;
    case 'setup': await cmdSetup(flags, sub); break;
    case 'service': await cmdService(flags, sub); break;
    case 'doctor': await cmdDoctor(flags); break;
    case 'backup':
      if (!sub) throw new Error('Utilisation : phenixrouter backup <fichier> --password <mdp>');
      await mutating(flags, (gw) => {
        writeFileSync(sub, createBackup(gw, backupPassword(flags)), { mode: 0o600 });
        console.log(`${green('✓')} Sauvegarde chiffrée écrite : ${sub}  ${dim('(gardez le mot de passe : il n’est pas récupérable)')}`);
      });
      break;
    case 'restore':
      if (!sub) throw new Error('Utilisation : phenixrouter restore <fichier> --password <mdp>');
      await mutating(flags, (gw) => {
        const r = restoreBackup(gw, readFileSync(sub, 'utf8'), backupPassword(flags));
        console.log(`${green('✓')} Restauré : ${r.connections} connexion(s), ${r.apiKeys} clé(s) API, ${r.proxies} proxy(s) — sauvegarde du ${r.exportedAt}`);
        if (r.safety) console.log(dim(`  Ancienne configuration conservée : ${r.safety}`));
      });
      break;
    case 'keys':
      if (sub === 'list') {
        await mutating(flags, (gw) => {
          const keys = gw.listApiKeys();
          if (!keys.length) console.log('Aucune clé.');
          for (const k of keys) console.log(`  ${k.id}  ${k.prefix}…  ${k.enabled ? green('actif') : red('désactivé')}  ${k.name}`);
        });
      } else if (sub === 'create') {
        const key = await createClientKey(flags, arg || 'cli');
        console.log(`Clé « ${arg || 'cli'} » créée (affichée une seule fois) :\n  ${orange(key)}`);
      } else if (sub === 'revoke' && arg) {
        await mutating(flags, (gw) => {
          const ok = gw.deleteApiKey(arg);
          gw.store.flush();
          console.log(ok ? 'Clé supprimée.' : 'Clé introuvable.');
        });
      } else {
        console.log(HELP);
      }
      break;
    case 'reset-password':
      await mutating(flags, async (gw) => {
        const pwd = sub || (await import('node:crypto')).randomBytes(9).toString('base64url');
        if (pwd.length < 8) throw new Error('8 caractères minimum');
        gw.setPassword(pwd);
        console.log(`Nouveau mot de passe : ${orange(pwd)}`);
      });
      break;
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(red(`Erreur : ${e?.message ?? e}`));
  process.exit(1);
});
