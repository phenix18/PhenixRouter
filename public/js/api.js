// Copyright (c) 2026 Fido-labs —kcw—
// Client de l'API d'administration.
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/login') && !path.startsWith('/api/session')) onUnauthorized();
    throw new ApiError(res.status, data?.error?.message ?? data?.error ?? `HTTP ${res.status}`);
  }
  return data;
}

/** Flux d'événements temps réel ; renvoie une fonction d'arrêt. */
export function subscribe(onEvent) {
  if (typeof EventSource === 'undefined') return () => {};
  const es = new EventSource('/api/events');
  es.onmessage = (m) => {
    try { onEvent(JSON.parse(m.data)); } catch { /* ignore */ }
  };
  return () => es.close();
}

export const baseUrl = () => window.location.origin;
