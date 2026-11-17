'use client';
/**
 * Realtime hook over the StringMind WebSocket (`WS_URL`).
 *
 * Auth: before every (re)connect we fetch a short-lived token from `/api/auth/ws-token` (same-origin proxy, so the
 * httpOnly session cookie applies) and connect to `WS_URL?token=…`. This is required in production where the web app
 * and the API are on different hosts and the browser would not send the session cookie to the API host.
 * If the token endpoint is unreachable (old API), we fall back to plain cookie auth (works on localhost).
 *
 *   const { connected } = useRealtime(`assessment:${id}`, (event, data) => { ... });
 *
 * - One shared socket per browser tab, multiplexed across channels (ref-counted subscriptions).
 * - Sends `{ type: 'subscribe', channel }` on open / reconnect, `{ type: 'unsubscribe', channel }` when the last listener leaves.
 * - Reconnects with exponential backoff (1s → 30s, jittered). Pass `channel = null` to disable.
 * - Incoming messages are expected as `{ channel, event, data }` (also tolerates `{ channel, type, payload }`).
 * - `onEvent` may change every render; the latest callback is always used.
 */
import { useEffect, useRef, useState } from 'react';
import { WS_URL, getActiveOrg } from './api';

type Listener = (event: string, data: any) => void;
type StatusListener = (connected: boolean) => void;

const listeners = new Map<string, Set<Listener>>();
const statusListeners = new Set<StatusListener>();
let socket: WebSocket | null = null;
let isOpen = false;
let attempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/** a token fetch + connect is in progress */
let connecting = false;

function setOpen(v: boolean) {
  isOpen = v;
  statusListeners.forEach((l) => l(v));
}

function send(msg: unknown) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try { socket.send(JSON.stringify(msg)); } catch { /* socket closing */ }
  }
}

function scheduleReconnect() {
  if (reconnectTimer || listeners.size === 0) return;
  const base = Math.min(30000, 1000 * 2 ** attempt);
  const delay = base / 2 + Math.random() * (base / 2);
  attempt += 1;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}

/** `{ token }` on success, `'unauthorized'` when signed out, `null` when the endpoint is unavailable. */
async function fetchWsToken(): Promise<string | 'unauthorized' | null> {
  try {
    const headers: Record<string, string> = {};
    const org = getActiveOrg();
    if (org) headers['x-aix-org'] = org;
    const res = await fetch('/api/auth/ws-token', { credentials: 'include', cache: 'no-store', headers });
    if (res.status === 401 || res.status === 403) return 'unauthorized';
    if (!res.ok) return null;
    const j = (await res.json()) as { token?: string };
    return typeof j.token === 'string' ? j.token : null;
  } catch {
    return null;
  }
}

function wsUrlWithToken(token: string | null) {
  if (!token) return WS_URL;
  return `${WS_URL}${WS_URL.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

function connect() {
  if (typeof window === 'undefined' || typeof WebSocket === 'undefined') return;
  if (connecting) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  connecting = true;
  void fetchWsToken().then((token) => {
    connecting = false;
    if (listeners.size === 0) return; // everyone left while we were fetching
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    if (token === 'unauthorized') { scheduleReconnect(); return; } // signed out: retry with backoff (e.g. after login)
    openSocket(token);
  });
}

function openSocket(token: string | null) {
  let ws: WebSocket;
  try { ws = new WebSocket(wsUrlWithToken(token)); } catch { scheduleReconnect(); return; }
  socket = ws;
  ws.onopen = () => {
    attempt = 0;
    setOpen(true);
    listeners.forEach((_, channel) => send({ type: 'subscribe', channel }));
  };
  ws.onmessage = (ev) => {
    let msg: any;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const channel: string | undefined = msg.channel;
    const event: string | undefined = msg.event ?? msg.type;
    const data = 'data' in msg ? msg.data : msg.payload;
    if (!channel || !event) return;
    listeners.get(channel)?.forEach((l) => { try { l(event, data); } catch (e) { console.error('[realtime] listener error', e); } });
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    setOpen(false);
    scheduleReconnect();
  };
  ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
}

function subscribe(channel: string, l: Listener) {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  let set = listeners.get(channel);
  if (!set) {
    set = new Set();
    listeners.set(channel, set);
    send({ type: 'subscribe', channel });
  }
  set.add(l);
  connect();
  return () => {
    const s = listeners.get(channel);
    if (!s) return;
    s.delete(l);
    if (s.size === 0) {
      listeners.delete(channel);
      send({ type: 'unsubscribe', channel });
    }
    if (listeners.size === 0) {
      // Close the idle socket shortly after the last subscriber leaves (survives quick remounts).
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (listeners.size === 0) {
          if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
          const ws = socket; socket = null;
          try { ws?.close(); } catch { /* ignore */ }
          setOpen(false);
        }
      }, 5000);
    }
  };
}

export function useRealtime(channel: string | null, onEvent: (event: string, data: any) => void): { connected: boolean } {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!channel) { setConnected(false); return; }
    const status: StatusListener = (v) => setConnected(v);
    statusListeners.add(status);
    const unsub = subscribe(channel, (e, d) => cb.current(e, d));
    setConnected(isOpen);
    return () => { statusListeners.delete(status); unsub(); };
  }, [channel]);

  return { connected };
}
