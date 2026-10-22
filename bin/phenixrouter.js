#!/usr/bin/env node
// Copyright (c) 2026 Fido-labs —kcw—
// PhenixRouter — lanceur en ligne de commande.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { importLegacyConfig } from '../src/core/legacy.js';
import { BRAND, VERSION, resolveDataDir } from '../src/config.js';
import { start } from '../src/server.js';
import { Gateway } from '../src/gateway.js';
import { PROVIDERS } from '../src/providers/registry.js';

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
  phenixrouter list                  Liste vos connexions (clés) et leur état
  phenixrouter models [--all]        Liste les modèles détectés (gratuit / payant, prix indicatif)
  phenixrouter status                Vérifie si le serveur tourne (/health)
  phenixrouter usage                 Requêtes, tokens et coût estimé (24 h / 7 j)
  phenixrouter import <config.json>  Importe les comptes d'un config.json « phenixRouter v3 » (Python)
  phenixrouter setup <outil> [--key K] [--write]   Configuration prête à l'emploi : claude | codex | openai
  phenixrouter reset-password [mdp]  Définit un nouveau mot de passe du tableau de bord
  phenixrouter --version | --help

${bold('Options de démarrage')}
  -p, --port <n>        Port (défaut ${BRAND.defaultPort}, env PORT)
      --host <addr>     Adresse d'écoute (défaut 127.0.0.1 ; 0.0.0.0 pour exposer)
      --data-dir <dir>  Dossier de données (défaut ~/.${BRAND.slug}, env PHENIX_DATA_DIR)
      --no-browser      N'ouvre pas le navigateur
      --all             (models) inclut aussi les modèles dont le fournisseur n'est pas connecté
      --key <clé>       (setup) clé API cliente à écrire dans la configuration (sinon PHENIX_API_KEY)
      --write           (setup claude) fusionne la configuration dans ~/.claude/settings.json (sauvegarde .bak)

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
    else if (a === '--all') out.flags.all = true;
    else if (a === '--write') out.flags.write = true;
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
  const app = await start({ port, host, dataDir: flags.dataDir });

  console.log(`\n${orange(bold(`  🔥 ${BRAND.name}`))} ${dim(`v${VERSION}`)}  ${dim('—')}  ${BRAND.tagline}`);
  console.log(dim(`  ${BRAND.copyright}\n`));
  console.log(`  ${bold('Tableau de bord')}   ${green(app.url)}`);
  console.log(`  ${bold('Endpoint OpenAI')}   ${green(`${app.url}/v1`)}   ${dim('(Anthropic : /v1/messages · Responses : /v1/responses)')}`);
  console.log(`  ${bold('Données')}           ${dim(resolveDataDir(flags.dataDir))}`);
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    console.log(`\n  ${red('⚠')}  Le serveur écoute sur ${host} : protégez-le (mot de passe fort, proxy HTTPS, pare-feu).`);
  }
  if (app.creds.firstRun) {
    console.log(`\n  ${bold('Premier lancement — notez ces identifiants (affichés une seule fois) :')}`);
    console.log(`  ${bold('Mot de passe du tableau de bord')} : ${orange(app.creds.password)}${app.creds.passwordFromEnv ? dim('  (PHENIX_PASSWORD)') : ''}`);
    if (app.creds.apiKey) console.log(`  ${bold('Clé API « default »')}             : ${orange(app.creds.apiKey)}`);
  }
  const configured = PROVIDERS.filter((p) => p.keyEnv && process.env[p.keyEnv]).map((p) => p.name);
  if (configured.length) console.log(`\n  ${green('✓')} Clés détectées dans l'environnement : ${configured.join(', ')}`);
  console.log(`\n  ${dim('Sans aucune clé, "phenix/auto" utilise Pollinations (sans clé). Ajoutez des clés gratuites dans « Fournisseurs ».')}`);
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

async function mutating(flags, fn) {
  const port = Number(flags.port ?? process.env.PORT ?? BRAND.defaultPort);
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
    const list = gw.catalog.list().filter((m) => flags.all || m.status === 'ready');
    console.log(`${list.length} modèle(s)${flags.all ? '' : ' prêt(s)'} :`);
    for (const m of list) console.log(`  ${m.id.padEnd(60)} ${fmtPrice(m).padEnd(24)} ${dim(m.tags.join(','))}`);
    if (!list.length) console.log(dim('  Aucun modèle prêt : ajoutez une clé, ou utilisez --all pour tout voir.'));
  } finally { gw.close(); }
}

async function cmdStatus(flags) {
  const port = Number(flags.port ?? process.env.PORT ?? BRAND.defaultPort);
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

function cmdSetup(flags, tool = 'claude') {
  const port = Number(flags.port ?? process.env.PORT ?? BRAND.defaultPort);
  const base = `http://127.0.0.1:${port}`;
  const key = flags.key || process.env.PHENIX_API_KEY?.split(',')[0] || 'phx-VOTRE_CLE';
  const pfx = BRAND.modelPrefix;
  if (tool === 'claude') {
    const env = { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_MODEL: `${pfx}/auto`, ANTHROPIC_SMALL_FAST_MODEL: `${pfx}/fast` };
    if (!flags.write) {
      console.log(bold('Claude Code — variables (ou ajoutez --write pour les fusionner dans ~/.claude/settings.json) :\n'));
      for (const [k, v] of Object.entries(env)) console.log(`export ${k}="${v}"`);
      console.log('\nclaude');
      return;
    }
    const file = join(homedir(), '.claude', 'settings.json');
    mkdirSync(dirname(file), { recursive: true });
    let cur = {};
    if (existsSync(file)) {
      copyFileSync(file, `${file}.bak`);
      try { cur = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`${file} n'est pas un JSON valide (sauvegarde : ${file}.bak)`); }
    }
    cur.env = { ...(cur.env ?? {}), ...env };
    writeFileSync(file, `${JSON.stringify(cur, null, 2)}\n`);
    console.log(`${green('✓')} Configuration écrite dans ${file}${existsSync(`${file}.bak`) ? dim(' (ancienne version : settings.json.bak)') : ''}`);
  } else if (tool === 'codex') {
    console.log(bold('Codex CLI — ajoutez à ~/.codex/config.toml :\n'));
    console.log(`model = "${pfx}/code"\nmodel_provider = "${pfx}"\n\n[model_providers.${pfx}]\nname = "${BRAND.name}"\nbase_url = "${base}/v1"\nenv_key = "PHENIX_API_KEY"\nwire_api = "responses"\n`);
    console.log(`puis : export PHENIX_API_KEY="${key}"`);
  } else if (tool === 'openai' || tool === 'generic') {
    console.log(bold('Tout client compatible OpenAI (Cursor, Cline, Continue, OpenCode…) :\n'));
    console.log(`Base URL : ${base}/v1\nAPI Key  : ${key}\nModèle   : ${pfx}/auto   (ou ${pfx}/free, ${pfx}/best, ${pfx}/code…)`);
  } else {
    throw new Error('Outil inconnu. Choix : claude | codex | openai');
  }
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
    case 'usage': await cmdUsage(flags); break;
    case 'import': await cmdImport(flags, sub); break;
    case 'setup': cmdSetup(flags, sub); break;
    case 'keys':
      if (sub === 'list') {
        await mutating(flags, (gw) => {
          const keys = gw.listApiKeys();
          if (!keys.length) console.log('Aucune clé.');
          for (const k of keys) console.log(`  ${k.id}  ${k.prefix}…  ${k.enabled ? green('actif') : red('désactivé')}  ${k.name}`);
        });
      } else if (sub === 'create') {
        await mutating(flags, (gw) => {
          const { key, record } = gw.createApiKey(arg || 'cli');
          gw.store.flush();
          console.log(`Clé « ${record.name} » créée (affichée une seule fois) :\n  ${orange(key)}`);
        });
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
