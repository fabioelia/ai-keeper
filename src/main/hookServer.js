'use strict';

const http = require('http');
const { EventEmitter } = require('events');

const MAX_BODY_BYTES = 256 * 1024;

// Receives Claude Code hook payloads. The installed hooks pipe the JSON that
// Claude Code writes to the hook's stdin straight to POST /event, e.g.:
//   { "hook_event_name": "Notification", "session_id": "...",
//     "transcript_path": "...", "message": "Claude needs your permission ..." }
//   { "hook_event_name": "Stop", "session_id": "...", "transcript_path": "..." }
// Notification fires for permission prompts and idle waiting; Stop fires when
// Claude finishes a turn. Both mean "a human should look at this session".
class HookServer extends EventEmitter {
  constructor({ port }) {
    super();
    this.port = port;
    this.server = null;
  }

  start() {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.on('error', (err) => {
        this.emit('error', err);
        resolve(false);
      });
      this.server.listen(this.port, '127.0.0.1', () => resolve(true));
    });
  }

  stop() {
    if (this.server) this.server.close();
  }

  handle(req, res) {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true,"app":"ai-keeper"}');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/event') {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = '';
    let overflow = false;
    req.on('data', (chunk) => {
      if (body.length > MAX_BODY_BYTES) {
        overflow = true;
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      if (overflow) return;
      const event = translate(body);
      if (event) this.emit('event', event);
    });
    req.on('error', () => {});
  }
}

function translate(body) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || !payload.session_id) return null;

  const base = {
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path || null,
    ts: Date.now(),
  };

  switch (payload.hook_event_name) {
    case 'Notification': {
      const message = typeof payload.message === 'string' ? payload.message : '';
      const kind = /permission/i.test(message) ? 'permission' : 'waiting';
      return { ...base, kind, message };
    }
    case 'Stop':
      return { ...base, kind: 'stop', message: 'Claude finished responding.' };
    case 'UserPromptSubmit':
      // The human replied; whatever attention state we had is resolved.
      return { ...base, kind: 'clear', message: '' };
    default:
      return null;
  }
}

module.exports = { HookServer, translate };
