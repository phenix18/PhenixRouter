// Copyright (c) 2026 Fido-labs —kcw—
// Audio « natif » (formes non OpenAI) : transcription Deepgram / Gemini, synthèse vocale ElevenLabs / Deepgram.
import { VERSION } from '../config.js';

const UA = `PhenixRouter/${VERSION}`;

/** Analyse minimale d'un corps multipart : champs texte + premier fichier (octets intacts). */
export function parseMultipart(buf, contentType) {
  const boundary = /boundary=("?)([^";]+)\1/i.exec(contentType)?.[2];
  if (!boundary) throw new Error('multipart sans boundary');
  const delim = Buffer.from(`--${boundary}`);
  const fields = {};
  let file = null;
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    const next = buf.indexOf(delim, pos + delim.length);
    if (next === -1) break;
    let part = buf.subarray(pos + delim.length, next);
    if (part.subarray(0, 2).toString() === '--') break;
    if (part.subarray(0, 2).toString() === '\r\n') part = part.subarray(2);
    const headEnd = part.indexOf('\r\n\r\n');
    if (headEnd !== -1) {
      const head = part.subarray(0, headEnd).toString('utf8');
      let data = part.subarray(headEnd + 4);
      if (data.subarray(-2).toString() === '\r\n') data = data.subarray(0, -2);
      const name = /name="([^"]*)"/i.exec(head)?.[1];
      const filename = /filename="([^"]*)"/i.exec(head)?.[1];
      if (filename !== undefined && !file) file = { name: filename, type: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() ?? 'application/octet-stream', data };
      else if (name) fields[name] = data.toString('utf8');
    }
    pos = next;
  }
  return { fields, file };
}

async function fail(res) {
  const text = await res.text();
  const err = new Error(text.replace(/\s+/g, ' ').slice(0, 240) || `HTTP ${res.status}`);
  err.status = res.status; err.body = text; err.headers = res.headers;
  return err;
}

const toFormat = (fmt, text) => {
  if (fmt === 'text') return { contentType: 'text/plain; charset=utf-8', body: Buffer.from(text) };
  return { contentType: 'application/json', body: Buffer.from(JSON.stringify({ text })) };
};

/** Transcription : renvoie { contentType, body(Buffer) }. */
export const STT = {
  async deepgram({ conn, key, model, mp, f, signal }) {
    if (!mp.file) throw new Error('fichier audio manquant');
    const params = new URLSearchParams({ model: model || 'nova-3', smart_format: 'true' });
    if (mp.fields.language) params.set('language', mp.fields.language); else params.set('detect_language', 'true');
    const res = await f(`${(conn.baseUrl || 'https://api.deepgram.com/v1').replace(/\/+$/, '')}/listen?${params}`, {
      method: 'POST', headers: { authorization: `Token ${key}`, 'content-type': mp.file.type, 'user-agent': UA }, body: mp.file.data, signal,
    });
    if (!res.ok) throw await fail(res);
    const j = await res.json();
    return toFormat(mp.fields.response_format, j.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '');
  },
  async gemini({ conn, key, model, mp, f, signal }) {
    if (!mp.file) throw new Error('fichier audio manquant');
    if (mp.file.data.length > 18 * 1024 * 1024) throw new Error('audio trop volumineux pour Gemini en ligne (18 Mo max)');
    const prompt = `Transcris fidèlement cet audio${mp.fields.language ? ` (langue : ${mp.fields.language})` : ''}. Réponds uniquement par la transcription.${mp.fields.prompt ? ` Contexte : ${mp.fields.prompt}` : ''}`;
    const res = await f(`${(conn.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '')}/models/${encodeURIComponent(model || 'gemini-2.5-flash')}:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key, 'user-agent': UA },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: mp.file.type, data: mp.file.data.toString('base64') } }] }] }), signal,
    });
    if (!res.ok) throw await fail(res);
    const j = await res.json();
    return toFormat(mp.fields.response_format, (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim());
  },
};

/** Synthèse vocale : `model` = « <voix> » ou « <modèle>/<voix> » selon le fournisseur. */
export const TTS = {
  async elevenlabs({ conn, key, model, json, f, signal }) {
    const [modelId, voice] = model.includes('/') ? model.split('/') : ['eleven_flash_v2_5', model || json.voice || '21m00Tcm4TlvDq8ikWAM'];
    const res = await f(`${(conn.baseUrl || 'https://api.elevenlabs.io/v1').replace(/\/+$/, '')}/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
      method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg', 'user-agent': UA }, body: JSON.stringify({ text: json.input, model_id: modelId }), signal,
    });
    if (!res.ok) throw await fail(res);
    return { contentType: 'audio/mpeg', body: Buffer.from(await res.arrayBuffer()) };
  },
  async deepgram({ conn, key, model, json, f, signal }) {
    const res = await f(`${(conn.baseUrl || 'https://api.deepgram.com/v1').replace(/\/+$/, '')}/speak?model=${encodeURIComponent(model || 'aura-2-thalia-en')}`, {
      method: 'POST', headers: { authorization: `Token ${key}`, 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify({ text: json.input }), signal,
    });
    if (!res.ok) throw await fail(res);
    return { contentType: res.headers.get('content-type') ?? 'audio/mpeg', body: Buffer.from(await res.arrayBuffer()) };
  },
};

/** Liste des voix (ElevenLabs). */
export async function listVoices(kind, { conn, key, f, signal }) {
  if (kind === 'elevenlabs') {
    const res = await f(`${(conn.baseUrl || 'https://api.elevenlabs.io/v1').replace(/\/+$/, '')}/voices`, { headers: { 'xi-api-key': key, 'user-agent': UA }, signal });
    if (!res.ok) throw await fail(res);
    const j = await res.json();
    return (j.voices ?? []).map((v) => ({ id: v.voice_id, name: v.name, model: `el/${v.voice_id}`, category: v.category, labels: v.labels ?? {} }));
  }
  if (kind === 'deepgram') {
    return ['aura-2-thalia-en', 'aura-2-andromeda-en', 'aura-2-helena-en', 'aura-2-apollo-en', 'aura-2-arcas-en', 'aura-asteria-en'].map((id) => ({ id, name: id, model: `deepgram/${id}` }));
  }
  return [];
}
