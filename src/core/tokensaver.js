// Copyright (c) 2026 Fido-labs —kcw—
// Token Saver : réduit la taille des gros résultats d'outils et des vieux messages avant l'envoi,
// pour économiser quota (gratuit) ou argent (payant) sans toucher aux instructions ni au dernier
// message de l'utilisateur. Purement local, aucun appel externe.

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Nettoie un texte : ANSI, espaces de fin, lignes vides multiples, lignes identiques consécutives. */
export function tidy(text) {
  const lines = String(text).replace(ANSI, '').replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  const out = [];
  let blank = 0;
  let prev = null;
  let repeat = 0;
  const flushRepeat = () => { if (repeat > 0) out.push(`  … (ligne répétée ${repeat} fois de plus)`); repeat = 0; };
  for (const line of lines) {
    if (line === '') {
      flushRepeat();
      blank += 1;
      if (blank <= 1) out.push(line);
      prev = null;
      continue;
    }
    blank = 0;
    if (line === prev && line.length > 3) { repeat += 1; continue; }
    flushRepeat();
    out.push(line);
    prev = line;
  }
  flushRepeat();
  return out.join('\n').trim();
}

/** Garde le début et la fin d'un texte trop long, avec un marqueur explicite au milieu. */
export function squeeze(text, maxChars) {
  const t = tidy(text);
  if (t.length <= maxChars) return t;
  const head = Math.floor(maxChars * 0.65);
  const tail = maxChars - head;
  const omitted = t.length - head - tail;
  return `${t.slice(0, head)}\n\n[… ${omitted} caractères omis par PhenixRouter Token Saver …]\n\n${t.slice(t.length - tail)}`;
}

function shrinkContent(content, maxChars) {
  if (typeof content === 'string') return content.length > maxChars * 0.5 ? squeeze(content, maxChars) : content;
  if (Array.isArray(content)) {
    return content.map((p) => (p?.type === 'text' && typeof p.text === 'string' && p.text.length > maxChars * 0.5 ? { ...p, text: squeeze(p.text, maxChars) } : p));
  }
  return content;
}

const size = (c) => (typeof c === 'string' ? c.length : JSON.stringify(c ?? '').length);

/**
 * @param {{messages?: any[]}} body corps au format OpenAI Chat Completions
 * @returns {{body: object, savedChars: number}}
 */
export function saveTokens(body, maxChars = 6000) {
  const messages = body?.messages;
  if (!Array.isArray(messages) || !messages.length) return { body, savedChars: 0 };
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]?.role === 'user') { lastUser = i; break; }
  let savedChars = 0;
  const next = messages.map((m, i) => {
    if (!m || m.role === 'system' || m.role === 'developer') return m;
    const eligible = m.role === 'tool' || (m.role === 'user' && i < lastUser);
    if (!eligible) return m;
    const before = size(m.content);
    const content = shrinkContent(m.content, m.role === 'tool' ? maxChars : maxChars * 2);
    const after = size(content);
    if (after < before) { savedChars += before - after; return { ...m, content }; }
    return m;
  });
  return savedChars > 0 ? { body: { ...body, messages: next }, savedChars } : { body, savedChars: 0 };
}
