// Copyright (c) 2026 Fido-labs —kcw—
// Tunnel d'accès distant (HTTPS public) via des outils EXTERNES déjà installés : cloudflared (URL trycloudflare.com,
// sans compte) ou Tailscale Funnel. PhenixRouter ne télécharge ni n'embarque aucun binaire.
// Sécurité : exposer le routeur sur Internet exige une clé API → le démarrage refuse sans clé et force requireApiKey.
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const TS_RE = /https:\/\/[a-z0-9.-]+\.ts\.net[^\s]*/i;

export function binaryAvailable(cmd) {
  try {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return r.status === 0 || (r.stdout || r.stderr || '').length > 0 ? !r.error : false;
  } catch { return false; }
}

export class Tunnel extends EventEmitter {
  constructor() {
    super();
    this.state = { status: 'stopped', provider: null, url: null, error: null, startedAt: null };
    this.proc = null;
  }

  status() {
    return {
      ...this.state,
      available: { cloudflared: binaryAvailable(process.env.PHENIX_CLOUDFLARED || 'cloudflared'), tailscale: binaryAvailable(process.env.PHENIX_TAILSCALE || 'tailscale') },
    };
  }

  async start(provider, port, { timeoutMs = 45000 } = {}) {
    if (this.state.status === 'running' || this.state.status === 'starting') throw new Error('Un tunnel est déjà actif');
    if (!['cloudflared', 'tailscale'].includes(provider)) throw new Error('Fournisseur de tunnel inconnu (cloudflared | tailscale)');
    this.state = { status: 'starting', provider, url: null, error: null, startedAt: Date.now() };
    try {
      const url = provider === 'cloudflared' ? await this._cloudflared(port, timeoutMs) : await this._tailscale(port, timeoutMs);
      this.state = { ...this.state, status: 'running', url };
      this.emit('change', this.state);
      return this.state;
    } catch (e) {
      this.stop();
      this.state = { status: 'error', provider, url: null, error: String(e.message ?? e), startedAt: null };
      this.emit('change', this.state);
      throw e;
    }
  }

  _cloudflared(port, timeoutMs) {
    const bin = process.env.PHENIX_CLOUDFLARED || 'cloudflared';
    return new Promise((resolve, reject) => {
      let proc;
      try { proc = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { reject(e); return; }
      this.proc = proc;
      const timer = setTimeout(() => reject(new Error('cloudflared n’a pas fourni d’URL à temps')), timeoutMs);
      const onData = (d) => { const m = URL_RE.exec(String(d)); if (m) { clearTimeout(timer); resolve(m[0]); } };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.once('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? 'cloudflared est introuvable : installez-le (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)' : e.message)); });
      proc.once('exit', (code) => {
        clearTimeout(timer);
        if (this.state.status === 'running') { this.state = { status: 'stopped', provider: null, url: null, error: code ? `cloudflared arrêté (code ${code})` : null, startedAt: null }; this.emit('change', this.state); this.proc = null; } else reject(new Error(`cloudflared s’est arrêté (code ${code})`));
      });
    });
  }

  _tailscale(port, timeoutMs) {
    const bin = process.env.PHENIX_TAILSCALE || 'tailscale';
    return new Promise((resolve, reject) => {
      const r = spawn(bin, ['funnel', '--bg', String(port)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      const timer = setTimeout(() => { r.kill(); reject(new Error('tailscale funnel : délai dépassé (le Funnel est-il activé pour ce nœud ?)')); }, timeoutMs);
      r.stdout.on('data', (d) => { out += d; });
      r.stderr.on('data', (d) => { out += d; });
      r.once('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? 'tailscale est introuvable : installez-le (https://tailscale.com/download)' : e.message)); });
      r.once('exit', (code) => {
        clearTimeout(timer);
        const m = TS_RE.exec(out);
        if (code === 0 && m) resolve(m[0].replace(/[).,]+$/, ''));
        else reject(new Error(code === 0 ? 'URL Funnel introuvable dans la sortie de tailscale' : `tailscale funnel a échoué : ${out.replace(/\s+/g, ' ').trim().slice(0, 200)}`));
      });
    });
  }

  stop() {
    const provider = this.state.provider;
    if (this.proc) { try { this.proc.kill(); } catch { /* ignore */ } this.proc = null; }
    if (provider === 'tailscale' && this.state.status !== 'stopped') {
      try { spawnSync(process.env.PHENIX_TAILSCALE || 'tailscale', ['funnel', 'reset'], { timeout: 8000, windowsHide: true }); } catch { /* ignore */ }
    }
    this.state = { status: 'stopped', provider: null, url: null, error: null, startedAt: null };
    this.emit('change', this.state);
  }
}
