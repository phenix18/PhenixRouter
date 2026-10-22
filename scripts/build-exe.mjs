// Copyright (c) 2026 Fido-labs —kcw—
// Construit un exécutable AUTONOME (Node SEA) : aucun Node ni npm requis pour l'utiliser.
//
//   node scripts/build-exe.mjs                       exécutable pour CETTE machine  → dist/phenixrouter(.exe)
//   node scripts/build-exe.mjs --target win-x64      cross-compilation (télécharge le binaire Node cible)
//     cibles : win-x64 · win-arm64 · linux-x64 · linux-arm64 · darwin-x64 · darwin-arm64
//
// Étapes : 1) bundle JS unique (esbuild, outil de build uniquement, via npx)  2) blob SEA avec les
// fichiers du tableau de bord embarqués  3) injection dans une copie du binaire Node (postject).
import { spawnSync } from 'node:child_process';
import {
  mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, chmodSync, existsSync,
} from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(root, 'build');
const dist = join(root, 'dist');
const args = process.argv.slice(2);
const target = args.includes('--target') ? args[args.indexOf('--target') + 1] : `${{ win32: 'win', darwin: 'darwin' }[process.platform] ?? 'linux'}-${process.arch}`;
const [os, arch] = target.split('-');
if (!['win', 'linux', 'darwin'].includes(os) || !['x64', 'arm64'].includes(arch)) throw new Error(`Cible inconnue : ${target}`);
const exeName = `phenixrouter-${target}${os === 'win' ? '.exe' : ''}`;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const isHost = target === `${{ win32: 'win', darwin: 'darwin' }[process.platform] ?? 'linux'}-${process.arch}`;

const sh = (cmd, argv, opts = {}) => {
  console.log(`$ ${[cmd, ...argv].join(' ')}`);
  const r = spawnSync(cmd, argv, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) throw new Error(`Échec : ${cmd} ${argv[0] ?? ''}`);
};

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Binaire Node cible : d'abord le registre npm (paquets node-<os>-<arch>), puis nodejs.org. */
async function nodeBinaryFor() {
  if (isHost) return process.execPath;
  const v = process.version.replace(/^v/, ''); // le blob doit venir de la même version de Node que le binaire hôte
  const tmp = join(tmpdir(), `phx-node-${target}-${v}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });

  const pkgName = `node-${os}-${arch}`;
  const packed = spawnSync('npm', ['pack', `${pkgName}@${v}`, '--silent', '--pack-destination', tmp], { encoding: 'utf8', shell: process.platform === 'win32' });
  const tgz = packed.status === 0 ? join(tmp, packed.stdout.trim().split('\n').pop()) : null;
  if (tgz && existsSync(tgz)) {
    sh('tar', ['-xzf', tgz, '-C', tmp]);
    const bin = join(tmp, 'package', 'bin', os === 'win' ? 'node.exe' : 'node');
    if (existsSync(bin)) return bin;
  }

  const base = `node-v${v}-${os}-${arch}`;
  const url = `https://nodejs.org/dist/v${v}/${base}.${os === 'win' ? 'zip' : 'tar.gz'}`;
  console.log(`Paquet npm ${pkgName}@${v} indisponible, essai de ${url}`);
  let res;
  try { res = await fetch(url); } catch (e) { throw new Error(`Binaire Node cible introuvable (${e.cause?.code ?? e.message}). Construisez sur la machine cible ou via GitHub Actions (.github/workflows/release.yml).`); }
  if (!res.ok) throw new Error(`Téléchargement impossible (${res.status}). Construisez sur la machine cible ou via GitHub Actions.`);
  const archive = join(tmp, os === 'win' ? 'node.zip' : 'node.tar.gz');
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  if (os === 'win') sh(process.platform === 'win32' ? 'tar' : 'unzip', process.platform === 'win32' ? ['-xf', archive, '-C', tmp] : ['-q', archive, `${base}/node.exe`, '-d', tmp]);
  else sh('tar', ['-xzf', archive, '-C', tmp, `${base}/bin/node`]);
  return join(tmp, base, os === 'win' ? 'node.exe' : join('bin', 'node'));
}

console.log(`\n🔥 PhenixRouter ${pkg.version} — build ${target}\n`);
rmSync(build, { recursive: true, force: true });
mkdirSync(build, { recursive: true });
mkdirSync(dist, { recursive: true });

// 1) Bundle CJS unique
const bundle = join(build, 'phenixrouter.cjs');
sh('npx', ['--yes', 'esbuild@0.25.10', 'bin/phenixrouter.js', '--bundle', '--platform=node', '--target=node22', '--format=cjs', `--outfile=${bundle}`,
  '--define:import.meta.url=__importMetaUrl', '--banner:js=const __importMetaUrl = require("node:url").pathToFileURL(__filename).href;', '--log-level=warning']);
writeFileSync(bundle, readFileSync(bundle, 'utf8').replace(/^#!.*\n/, ''));

// 2) Blob SEA avec les assets
const assets = { 'brand.json': join(root, 'brand.json'), 'package.json': join(root, 'package.json') };
for (const f of walk(join(root, 'public'))) assets[relative(root, f).split(sep).join('/')] = f;
const seaConfig = join(build, 'sea-config.json');
const blob = join(build, 'sea-prep.blob');
writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, assets }, null, 2));
sh(process.execPath, ['--experimental-sea-config', seaConfig]);

// 3) Injection dans une copie du binaire Node
const exe = join(dist, exeName);
copyFileSync(await nodeBinaryFor(), exe);
if (os !== 'win') chmodSync(exe, 0o755);
if (os === 'darwin' && process.platform === 'darwin') spawnSync('codesign', ['--remove-signature', exe], { stdio: 'inherit' });
const inject = ['--yes', 'postject@1.0.0-alpha.6', exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (os === 'darwin') inject.push('--macho-segment-name', 'NODE_SEA');
sh('npx', inject);
if (os === 'darwin' && process.platform === 'darwin') spawnSync('codesign', ['--sign', '-', exe], { stdio: 'inherit' });

const mb = (statSync(exe).size / 1024 / 1024).toFixed(1);
console.log(`\n✅ ${relative(root, exe)} (${mb} Mo)`);
if (isHost && !args.includes('--no-smoke') && existsSync(exe)) {
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8' });
  console.log(`   Test : ${exe} --version → ${(r.stdout || r.stderr || '').trim() || `échec (code ${r.status})`}`);
  if (r.status !== 0) process.exit(1);
}
