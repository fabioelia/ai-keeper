'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { RelayClient, RemoteSessions, subscribeUrl, toRemoteItem } = require('../src/main/relay');

function hookJson(overrides = {}) {
  return JSON.stringify({
    hook_event_name: 'Notification',
    session_id: 'web-1',
    cwd: '/home/user/checkout-service',
    message: 'Claude needs your permission to use Bash',
    ...overrides,
  });
}

test('subscribeUrl appends /json once and trims slashes', () => {
  assert.strictEqual(subscribeUrl('https://ntfy.sh/topic'), 'https://ntfy.sh/topic/json');
  assert.strictEqual(subscribeUrl('https://ntfy.sh/topic/'), 'https://ntfy.sh/topic/json');
  assert.strictEqual(subscribeUrl('https://ntfy.sh/topic/json'), 'https://ntfy.sh/topic/json');
});

test('handleLine decodes ntfy frames and ignores keepalives', () => {
  const client = new RelayClient({ url: 'https://ntfy.sh/t' });
  const events = [];
  client.on('event', (event) => events.push(event));

  client.handleLine(JSON.stringify({ event: 'open', id: 'x' }));
  client.handleLine(JSON.stringify({ event: 'keepalive', id: 'y' }));
  client.handleLine(JSON.stringify({ event: 'message', message: hookJson() }));
  client.handleLine('not json at all');
  client.handleLine(''); // blank

  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].kind, 'permission');
  assert.strictEqual(events[0].origin, 'remote');
  assert.strictEqual(events[0].sessionId, 'web-1');
  assert.strictEqual(events[0].cwd, '/home/user/checkout-service');
});

test('handleLine accepts raw hook JSON lines from bare relays', () => {
  const client = new RelayClient({ url: 'https://relay.example/stream' });
  const events = [];
  client.on('event', (event) => events.push(event));
  client.handleLine(hookJson({ hook_event_name: 'Stop', message: undefined }));
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].kind, 'stop');
});

test('RemoteSessions tracks latest event per session and clears on prompt submit', () => {
  const remote = new RemoteSessions();
  const now = Date.now();
  remote.apply({ sessionId: 'web-1', kind: 'permission', message: 'permission to use Bash', cwd: '/repo/checkout', ts: now });
  remote.apply({ sessionId: 'web-2', kind: 'stop', message: 'Claude finished responding.', cwd: '/repo/api', ts: now });

  let items = remote.items(now);
  assert.strictEqual(items.length, 2);
  const byId = Object.fromEntries(items.map((i) => [i.sessionId, i]));
  assert.strictEqual(byId['web-1'].state, 'needs_input');
  assert.strictEqual(byId['web-1'].reason, 'permission');
  assert.strictEqual(byId['web-1'].remote, true);
  assert.strictEqual(byId['web-1'].project, 'checkout');
  assert.strictEqual(byId['web-2'].reason, 'reply');

  // The human replied in the web UI -> session flips to working, keeps cwd.
  remote.apply({ sessionId: 'web-1', kind: 'clear', ts: now + 1000 });
  items = remote.items(now + 1000);
  const updated = items.find((i) => i.sessionId === 'web-1');
  assert.strictEqual(updated.state, 'working');
  assert.strictEqual(updated.project, 'checkout');
});

test('RemoteSessions drops stale entries and caps the map', () => {
  const remote = new RemoteSessions();
  const now = Date.now();
  remote.apply({ sessionId: 'old', kind: 'stop', ts: now - 25 * 60 * 60 * 1000 });
  assert.strictEqual(remote.items(now).length, 0, 'older than a day is hidden');

  for (let i = 0; i < 60; i++) {
    remote.apply({ sessionId: `s${i}`, kind: 'stop', ts: now + i });
  }
  assert.ok(remote.map.size <= 50, 'capped at 50 tracked sessions');
});

test('toRemoteItem shapes fields like local items', () => {
  const item = toRemoteItem({ sessionId: 'w', kind: 'waiting', message: 'idle', cwd: null, ts: 123 });
  assert.strictEqual(item.state, 'needs_input');
  assert.strictEqual(item.statusMessage, 'Waiting for next steps.');
  assert.strictEqual(item.project, 'web session');
  assert.strictEqual(item.lastActivity, 123);
  assert.strictEqual(item.needsAttention, true);
});

test('RelayClient streams events from an ntfy-style endpoint', async () => {
  let response;
  const server = http.createServer((req, res) => {
    assert.strictEqual(req.url, '/topic/json');
    response = res;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(`${JSON.stringify({ event: 'open' })}\n`);
    res.write(`${JSON.stringify({ event: 'message', message: hookJson() })}\n`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const client = new RelayClient({ url: `http://127.0.0.1:${port}/topic` });
  const gotEvent = new Promise((resolve) => client.once('event', resolve));
  const gotConnected = new Promise((resolve) => client.once('status', resolve));
  client.start();

  const status = await gotConnected;
  assert.strictEqual(status.connected, true);
  const event = await gotEvent;
  assert.strictEqual(event.sessionId, 'web-1');
  assert.strictEqual(event.kind, 'permission');

  client.stop();
  if (response) response.end();
  server.close();
});
