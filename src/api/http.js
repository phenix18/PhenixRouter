// Copyright (c) 2026 Fido-labs —kcw—
// Utilitaires HTTP minimalistes (zéro dépendance).
import { httpError } from '../gateway.js';

export async function readJson(req, limit = 10 * 1024 * 1024) {
  const len = Number(req.headers['content-length'] ?? 0);
  if (len > limit) throw httpError(413, 'Corps de requête trop volumineux');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw httpError(413, 'Corps de requête trop volumineux');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw httpError(400, 'JSON invalide');
  }
}

export async function readRaw(req, limit = 26 * 1024 * 1024) {
  const len = Number(req.headers['content-length'] ?? 0);
  if (len > limit) throw httpError(413, 'Fichier trop volumineux (25 Mo max)');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw httpError(413, 'Fichier trop volumineux (25 Mo max)');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export function sendJson(res, status, obj, headers = {}) {
  if (res.headersSent) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export const openaiErrorBody = (status, message, type = 'api_error', code = null, extra = {}) => ({
  error: { message, type, code, ...extra },
});

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function clientIp(req) {
  return req.socket?.remoteAddress ?? 'unknown';
}

export function bearer(req) {
  const h = String(req.headers.authorization ?? '');
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : (req.headers['x-api-key'] ? String(req.headers['x-api-key']).trim() : null);
}
