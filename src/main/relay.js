'use strict';

const path = require('path');
const { EventEmitter } = require('events');
const { translate } = require('./hookServer');
const { STALE_AFTER_MS } = require('./constants');

const MAX_REMOTE_SESSIONS = 50;

// Remote Claude Code sessions (claude.ai/code) run in cloud containers, so
// their transcripts never touch this machine. Instead, those sessions carry
// HTTP hooks (configured in the repo's .claude/settings.json) that POST the
// hook payload to a relay the user controls. RelayClient subscribes to that
// relay and feeds the events into the same pipeline as local hooks.
//
// The default protocol is ntfy (https://ntfy.sh or self-hosted): subscribe to
// `<topic-url>/json`, a long-lived HTTP response streaming one JSON frame per
// line: {"event":"open"|"keepalive"|"message", "message":"<posted body>"}.
// The posted body is the Claude Code hook JSON. Raw hook-JSON lines (from a
// bare self-hosted relay) are accepted too.
class RelayClient extends EventEmitter {
  constructor({ url, token } = {}) {
    super();
    this.url = url;
    this.token = token || null;
    this.controller = null;
    this.stopped = true;
    this.connected = false;
    this.backoffMs = 2_000;
  }

  start() {
    if (!this.url) return;
    this.stopped = false;
    this.loop().catch(() => {});
  }

  stop() {
    this.stopped = true;
    if (this.controller) this.controller.abort();
    this.setConnected(false);
  }

  async loop() {
    while (!this.stopped) {
      try {
        await this.streamOnce();
        this.backoffMs = 2_000; // stream ended cleanly; reconnect quickly
      } catch {
        this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
      }
      this.setConnected(false);
      if (this.stopped) break;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, this.backoffMs);
        if (timer.unref) timer.unref();
      });
    }
  }

  async streamOnce() {
    this.controller = new AbortController();
    const headers = { Accept: 'application/x-ndjson' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await fetch(subscribeUrl(this.url), { headers, signal: this.controller.signal });
    if (!res.ok || !res.body) throw new Error(`relay responded ${res.status}`);
    this.setConnected(true);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        this.handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    }
  }

  handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let frame;
    try {
      frame = JSON.parse(trimmed);
    } catch {
      return;
    }
    let hookBody;
    if (typeof frame.event === 'string') {
      // ntfy frame; only 'message' frames carry a posted payload
      if (frame.event !== 'message' || typeof frame.message !== 'string') return;
      hookBody = frame.message;
    } else {
      // bare relay streaming raw hook JSON lines
      hookBody = trimmed;
    }
    const event = translate(hookBody);
    if (event) this.emit('event', { ...event, origin: 'remote' });
  }

  setConnected(connected) {
    if (this.connected === connected) return;
    this.connected = connected;
    this.emit('status', { connected });
  }
}

function subscribeUrl(base) {
  const clean = String(base || '').replace(/\/+$/, '');
  return clean.endsWith('/json') ? clean : `${clean}/json`;
}

// Event-sourced view of remote sessions. Unlike local sessions there is no
// transcript to inspect, so state is exactly what the last hook event said.
class RemoteSessions {
  constructor() {
    this.map = new Map(); // sessionId -> { sessionId, kind, message, cwd, ts }
  }

  apply(event) {
    if (!event || !event.sessionId) return;
    const existing = this.map.get(event.sessionId) || {};
    if (event.kind === 'clear') {
      // The human replied in the web UI; Claude is working again.
      this.map.set(event.sessionId, {
        ...existing,
        sessionId: event.sessionId,
        kind: 'working',
        message: 'Working…',
        cwd: event.cwd || existing.cwd || null,
        ts: event.ts || Date.now(),
      });
    } else {
      this.map.set(event.sessionId, {
        sessionId: event.sessionId,
        kind: event.kind,
        message: event.message || '',
        cwd: event.cwd || existing.cwd || null,
        ts: event.ts || Date.now(),
      });
    }
    if (this.map.size > MAX_REMOTE_SESSIONS) {
      const oldest = [...this.map.values()].sort((a, b) => a.ts - b.ts)[0];
      this.map.delete(oldest.sessionId);
    }
  }

  items(now = Date.now()) {
    const out = [];
    for (const entry of this.map.values()) {
      if (now - entry.ts > STALE_AFTER_MS) continue;
      out.push(toRemoteItem(entry));
    }
    return out;
  }
}

function toRemoteItem(entry) {
  let state = 'working';
  let reason = null;
  let statusMessage = 'Working…';
  if (entry.kind === 'permission') {
    state = 'needs_input';
    reason = 'permission';
    statusMessage = entry.message || 'Needs permission to continue.';
  } else if (entry.kind === 'waiting' || entry.kind === 'stop') {
    state = 'needs_input';
    reason = 'reply';
    statusMessage = 'Waiting for next steps.';
  }
  const project = entry.cwd ? path.basename(entry.cwd) : 'web session';
  return {
    sessionId: entry.sessionId,
    remote: true,
    filePath: null,
    cwd: entry.cwd || null,
    project,
    title: `${project} — Claude Code on the web`,
    state,
    reason,
    statusMessage,
    needsAttention: state === 'needs_input',
    lastActivity: entry.ts,
    lastAssistantText: entry.kind === 'stop' ? entry.message : null,
    lastAssistantUuid: null,
    pendingToolUse: null,
  };
}

module.exports = { RelayClient, RemoteSessions, subscribeUrl, toRemoteItem };
