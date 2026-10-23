// Copyright (c) 2026 Fido-labs —kcw—
// Écriture de la configuration des outils clients (Claude Code, Codex, OpenCode, Cline, Droid, Copilot/VS Code)
// pour qu'ils utilisent PhenixRouter. Fusion non destructive + sauvegarde .bak ; retrait possible.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { BRAND } from '../config.js';

const PFX = BRAND.modelPrefix; // « phenix »
const MODELS = ['auto', 'free', 'best', 'fast', 'smart', 'code'].map((m) => `${PFX}/${m}`);
const NAME = BRAND.name;
const MARK_BEGIN = `# >>> ${PFX}router (géré automatiquement)`;
const MARK_END = `# <<< ${PFX}router`;

const readJsonLoose = (file, fallback) => {
  if (!existsSync(file)) return fallback;
  const raw = readFileSync(file, 'utf8');
  try { return JSON.parse(raw); } catch {
    try { return JSON.parse(raw.replace(/,(\s*[}\]])/g, '$1')); } catch { throw new Error(`${file} n'est pas un JSON valide (corrigez-le ou supprimez-le ; rien n'a été modifié)`); }
  }
};

function write(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) copyFileSync(file, `${file}.bak`);
  writeFileSync(file, text);
}

const writeJson = (file, obj) => write(file, `${JSON.stringify(obj, null, 2)}\n`);
const v1 = (base) => `${base.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`;
const root = (base) => base.replace(/\/+$/, '').replace(/\/v1$/, '');

function vscodeDir(home, platform) {
  if (platform === 'win32') return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Code', 'User');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Code', 'User');
  return join(home, '.config', 'Code', 'User');
}

/** Description de chaque outil : fichier visé, application, retrait. */
export const TOOLS = {
  claude: {
    label: 'Claude Code', file: (h) => join(h, '.claude', 'settings.json'),
    apply(file, { base, key }) {
      const cur = readJsonLoose(file, {});
      cur.env = { ...(cur.env ?? {}), ANTHROPIC_BASE_URL: root(base), ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_MODEL: `${PFX}/auto`, ANTHROPIC_SMALL_FAST_MODEL: `${PFX}/fast`, ANTHROPIC_DEFAULT_OPUS_MODEL: `${PFX}/smart`, ANTHROPIC_DEFAULT_SONNET_MODEL: `${PFX}/code`, ANTHROPIC_DEFAULT_HAIKU_MODEL: `${PFX}/fast` };
      writeJson(file, cur);
    },
    remove(file) {
      const cur = readJsonLoose(file, null);
      if (!cur?.env) return false;
      for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']) delete cur.env[k];
      writeJson(file, cur); return true;
    },
  },
  codex: {
    label: 'Codex CLI', file: (h) => join(h, '.codex', 'config.toml'), note: `Lancez ensuite : codex --profile ${PFX}  (et exportez PHENIX_API_KEY)`,
    apply(file, { base }) {
      const block = `${MARK_BEGIN}\n[model_providers.${PFX}]\nname = "${NAME}"\nbase_url = "${v1(base)}"\nenv_key = "PHENIX_API_KEY"\nwire_api = "responses"\n\n[profiles.${PFX}]\nmodel = "${PFX}/code"\nmodel_provider = "${PFX}"\n${MARK_END}\n`;
      const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
      const re = new RegExp(`${MARK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${MARK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`);
      write(file, re.test(cur) ? cur.replace(re, block) : `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${cur ? '\n' : ''}${block}`);
    },
    remove(file) {
      if (!existsSync(file)) return false;
      const cur = readFileSync(file, 'utf8');
      const re = new RegExp(`\\n?${MARK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${MARK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`);
      if (!re.test(cur)) return false;
      write(file, cur.replace(re, '\n')); return true;
    },
  },
  opencode: {
    label: 'OpenCode', file: (h) => join(h, '.config', 'opencode', 'opencode.json'),
    apply(file, { base, key, models = MODELS }) {
      const cur = readJsonLoose(file, {});
      cur.$schema ??= 'https://opencode.ai/config.json';
      cur.provider ??= {};
      const prev = cur.provider[PFX] ?? { npm: '@ai-sdk/openai-compatible', options: {}, models: {} };
      prev.npm ??= '@ai-sdk/openai-compatible';
      prev.name = NAME;
      prev.options = { ...(prev.options ?? {}), baseURL: v1(base), apiKey: key };
      prev.models = { ...(prev.models ?? {}), ...Object.fromEntries(models.map((m) => [m.replace(`${PFX}/`, ''), { name: m }])) };
      cur.provider[PFX] = prev;
      cur.model = `${PFX}/auto`;
      writeJson(file, cur);
    },
    remove(file) {
      const cur = readJsonLoose(file, null);
      if (!cur?.provider?.[PFX]) return false;
      delete cur.provider[PFX];
      if (String(cur.model ?? '').startsWith(`${PFX}/`)) delete cur.model;
      writeJson(file, cur); return true;
    },
  },
  cline: {
    label: 'Cline (CLI)', file: (h) => join(h, '.cline', 'data', 'globalState.json'),
    apply(file, { base, key }) {
      const st = readJsonLoose(file, {});
      Object.assign(st, { actModeApiProvider: 'openai', planModeApiProvider: 'openai', openAiBaseUrl: root(base), openAiModelId: `${PFX}/auto`, planModeOpenAiModelId: `${PFX}/auto` });
      writeJson(file, st);
      const sec = join(dirname(file), 'secrets.json');
      const s = readJsonLoose(sec, {});
      s.openAiApiKey = key;
      writeJson(sec, s);
    },
    remove(file) {
      const st = readJsonLoose(file, null);
      if (!st || st.actModeApiProvider !== 'openai') return false;
      for (const k of ['openAiBaseUrl', 'openAiModelId', 'planModeOpenAiModelId']) delete st[k];
      st.actModeApiProvider = 'cline'; st.planModeApiProvider = 'cline';
      writeJson(file, st);
      const sec = join(dirname(file), 'secrets.json');
      const s = readJsonLoose(sec, null);
      if (s) { delete s.openAiApiKey; writeJson(sec, s); }
      return true;
    },
  },
  droid: {
    label: 'Factory Droid', file: (h) => join(h, '.factory', 'settings.json'),
    apply(file, { base, key, models = MODELS }) {
      const cur = readJsonLoose(file, {});
      const keep = (cur.customModels ?? []).filter((m) => !String(m.id ?? '').startsWith(`custom:${NAME}`));
      const mine = models.map((m, i) => ({ model: m, id: `custom:${NAME}-${i}`, index: i, baseUrl: v1(base), apiKey: key, displayName: m, maxOutputTokens: 131072, noImageSupport: false, provider: 'openai' }));
      cur.customModels = [...mine, ...keep].map((m, i) => ({ ...m, index: i }));
      writeJson(file, cur);
    },
    remove(file) {
      const cur = readJsonLoose(file, null);
      if (!cur?.customModels) return false;
      const before = cur.customModels.length;
      cur.customModels = cur.customModels.filter((m) => !String(m.id ?? '').startsWith(`custom:${NAME}`));
      if (!cur.customModels.length) delete cur.customModels;
      writeJson(file, cur); return cur.customModels?.length !== before;
    },
  },
  copilot: {
    label: 'GitHub Copilot Chat (VS Code, modèles perso)', file: (h, p) => join(vscodeDir(h, p), 'chatLanguageModels.json'),
    apply(file, { base, key, models = MODELS }) {
      let cfg = readJsonLoose(file, []);
      if (!Array.isArray(cfg)) cfg = [];
      const entry = { name: NAME, vendor: 'azure', apiKey: key, models: models.map((id) => ({ id, name: id, url: `${v1(base)}/chat/completions#models.ai.azure.com`, toolCalling: true, vision: false, maxInputTokens: 128000, maxOutputTokens: 16000 })) };
      const i = cfg.findIndex((e) => e.name === NAME);
      if (i >= 0) cfg[i] = entry; else cfg.push(entry);
      writeJson(file, cfg);
    },
    remove(file) {
      const cfg = readJsonLoose(file, null);
      if (!Array.isArray(cfg)) return false;
      const next = cfg.filter((e) => e.name !== NAME);
      if (next.length === cfg.length) return false;
      writeJson(file, next); return true;
    },
  },
};

/** Instructions à copier pour les outils sans fichier géré (Continue, Aider, Cursor…). */
export function manualSnippets({ base, key }) {
  return {
    openai: `Base URL : ${v1(base)}\nAPI Key  : ${key}\nModèle   : ${PFX}/auto   (ou ${PFX}/free, ${PFX}/best, ${PFX}/code…)`,
    continue: `# ~/.continue/config.yaml\nmodels:\n  - name: ${NAME}\n    provider: openai\n    model: ${PFX}/auto\n    apiBase: ${v1(base)}\n    apiKey: ${key}`,
    aider: `export OPENAI_API_BASE=${v1(base)}\nexport OPENAI_API_KEY=${key}\naider --model openai/${PFX}/auto`,
    gemini: `export GOOGLE_GEMINI_BASE_URL=${root(base)}\nexport GEMINI_API_KEY=${key}\n# API Gemini native servi sous /v1beta (modèle : ${PFX}/auto)`,
  };
}

export function toolPaths({ home = homedir(), platform = process.platform } = {}) {
  return Object.entries(TOOLS).map(([id, t]) => { const file = t.file(home, platform); return { id, label: t.label, file, exists: existsSync(file), note: t.note ?? null }; });
}

export function applyTool(id, opts) {
  const t = TOOLS[id];
  if (!t) throw new Error(`Outil inconnu : ${id}`);
  const home = opts.home ?? homedir();
  const file = t.file(home, opts.platform ?? process.platform);
  if (!opts.key) throw new Error('Clé API cliente requise');
  t.apply(file, opts);
  return { id, file, note: t.note ?? null, backup: existsSync(`${file}.bak`) ? `${file}.bak` : null };
}

export function removeTool(id, opts = {}) {
  const t = TOOLS[id];
  if (!t) throw new Error(`Outil inconnu : ${id}`);
  const file = t.file(opts.home ?? homedir(), opts.platform ?? process.platform);
  return { id, file, removed: !!t.remove(file) };
}
