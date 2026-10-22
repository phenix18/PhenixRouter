#!/usr/bin/env node
// Copyright (c) 2026 Fido-labs —kcw—
// PhenixRouter — lanceur en ligne de commande.
import { spawn } from 'node:child_process';
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
  phenixrouter providers             Liste les fournisseurs gratuits pris en charge
  phenixrouter reset-password [mdp]  Définit un nouveau mot de passe du tableau de bord
  phenixrouter --version | --help

${bold('Options de démarrage')}
  -p, --port <n>        Port (défaut ${BRAND.defaultPort}, env PORT)
      --host <addr>     Adresse d'écoute (défaut 127.0.0.1 ; 0.0.0.0 pour exposer)
      --data-dir <dir>  Dossier de données (défaut ~/.${BRAND.slug}, env PHENIX_DATA_DIR)
      --no-browser      N'ouvre pas le navigateur

${bold('Variables d\'environnement utiles')}
  GROQ_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY, CEREBRAS_API_KEY, MISTRAL_API_KEY,
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
        console.log(`  ${bold(p.id.padEnd(13))} ${p.name}${env}`);
      }
      break;
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
