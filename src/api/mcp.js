// Copyright (c) 2026 Fido-labs —kcw—
// Serveur MCP (Model Context Protocol, HTTP « streamable » sans état, JSON-RPC 2.0) sur POST /mcp.
// Expose le routeur comme outils : chat, recherche web, lecture de page, images, modèles, usage.
// Ajoutez-le à Claude Code : claude mcp add --transport http phenix http://127.0.0.1:20128/mcp --header "Authorization: Bearer phx-…"
import { httpError } from '../gateway.js';
import { readJson, sendJson } from './http.js';
import { authenticate, listModels } from './v1.js';
import { runChat } from '../core/chat.js';
import { runSearch, runFetch } from '../core/webproviders.js';
import { runImages } from '../core/imagegen.js';
import { listByType } from '../core/modeltypes.js';
import { BRAND, VERSION } from '../config.js';

const PROTOCOL = '2025-03-26';
const str = (description) => ({ type: 'string', description });
const obj = (properties, required = []) => ({ type: 'object', properties, required });

const TOOLS = [
  { name: 'phenix_chat', description: 'Pose une question à un modèle via le routeur (gratuit d’abord, bascule automatique).', inputSchema: obj({ prompt: str('Question ou consigne'), model: str('Modèle (défaut phenix/auto ; phenix/free, phenix/best, phenix/code…)'), system: str('Consigne système (facultatif)') }, ['prompt']) },
  { name: 'phenix_search', description: 'Recherche web (Tavily, Brave, Serper… ou repli gratuit).', inputSchema: obj({ query: str('Requête'), max_results: { type: 'integer', description: '1-20 (défaut 5)' }, provider: str('Fournisseur (facultatif)') }, ['query']) },
  { name: 'phenix_fetch', description: 'Lit une page web et renvoie son contenu (markdown/texte).', inputSchema: obj({ url: str('URL http(s)'), max_characters: { type: 'integer' } }, ['url']) },
  { name: 'phenix_image', description: 'Génère une image (Pollinations gratuit, ou fournisseurs configurés). Renvoie l’URL ou un aperçu base64 tronqué.', inputSchema: obj({ prompt: str('Description'), size: str('ex. 1024x1024'), model: str('facultatif') }, ['prompt']) },
  { name: 'phenix_models', description: 'Liste les modèles disponibles par type (chat, image, tts, stt, embedding, web, video).', inputSchema: obj({ type: str('chat (défaut) | image | tts | stt | embedding | web | video') }) },
  { name: 'phenix_usage', description: 'Résumé d’usage et coût estimé (24 h).', inputSchema: obj({}) },
];

const text = (t, isError = false) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }], ...(isError ? { isError: true } : {}) });

async function callTool(gw, name, args, base) {
  switch (name) {
    case 'phenix_chat': {
      if (!args.prompt) throw new Error('« prompt » est requis');
      const messages = [...(args.system ? [{ role: 'system', content: String(args.system) }] : []), { role: 'user', content: String(args.prompt) }];
      const out = await runChat(gw, { model: args.model || 'phenix/auto', messages, stream: false }, { ...base, route: 'mcp', requestedModel: args.model || 'phenix/auto' });
      return text(`${out.json.choices?.[0]?.message?.content ?? ''}\n\n— ${out.meta.served}`);
    }
    case 'phenix_search': return text(await runSearch(gw, args, base));
    case 'phenix_fetch': return text(await runFetch(gw, args, base));
    case 'phenix_image': {
      const out = await runImages(gw, { prompt: args.prompt, size: args.size, model: args.model, response_format: 'url' }, base);
      const d = out.data[0];
      return text(d.url ? `Image : ${d.url}` : `Image générée (${out.model}) : base64 de ${d.b64_json.length} caractères (utilisez POST /v1/images/generations?response_format=binary pour le fichier).`);
    }
    case 'phenix_models': {
      const type = args.type || 'chat';
      const data = type === 'chat' ? listModels(gw, false).data : listByType(gw, type).data;
      return text(data.map((m) => m.id));
    }
    case 'phenix_usage': return text({ last24h: gw.ledger.summary({ sinceMs: 24 * 3600 * 1000 }), spend: gw.spend(), costMode: gw.settings().costMode });
    default: throw new Error(`Outil inconnu : ${name}`);
  }
}

export async function handleMcp(gw, req, res, ctx) {
  const rpcError = (id, code, message, status = 200) => sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  try {
    const client = authenticate(gw, req);
    if (req.method === 'GET' || req.method === 'DELETE') { res.writeHead(405, { allow: 'POST' }); res.end(); return; }
    if (req.method !== 'POST') throw httpError(405, 'Méthode non autorisée');
    const msg = await readJson(req);
    if (Array.isArray(msg)) { rpcError(null, -32600, 'Les lots JSON-RPC ne sont pas pris en charge'); return; }
    if (msg.id === undefined) { res.writeHead(202); res.end(); return; } // notification
    const base = { client: `mcp:${client.name}`, signal: ctx.signal };
    switch (msg.method) {
      case 'initialize':
        sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: BRAND.slug, version: VERSION } } }); return;
      case 'ping': sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: {} }); return;
      case 'tools/list': sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } }); return;
      case 'tools/call': {
        const name = msg.params?.name;
        if (!TOOLS.some((t) => t.name === name)) { rpcError(msg.id, -32602, `Outil inconnu : ${name}`); return; }
        let result;
        try { result = await callTool(gw, name, msg.params?.arguments ?? {}, base); } catch (e) { result = text(`Erreur : ${e.message ?? e}`, true); }
        sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result }); return;
      }
      default: rpcError(msg.id, -32601, `Méthode inconnue : ${msg.method}`);
    }
  } catch (e) {
    const status = Number.isInteger(e?.status) ? e.status : 500;
    sendJson(res, status === 401 ? 401 : status, { jsonrpc: '2.0', id: null, error: { code: -32000, message: status === 500 ? 'Erreur interne' : String(e.message ?? e) } });
  }
}
