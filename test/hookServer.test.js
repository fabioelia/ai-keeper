'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { HookServer, translate } = require('../src/main/hookServer');

test('translate maps Notification permission messages', () => {
  const event = translate(
    JSON.stringify({
      hook_event_name: 'Notification',
      session_id: 's1',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/work/app',
      message: 'Claude needs your permission to use Bash',
    }),
  );
  assert.strictEqual(event.kind, 'permission');
  assert.strictEqual(event.sessionId, 's1');
  assert.strictEqual(event.transcriptPath, '/tmp/t.jsonl');
  assert.strictEqual(event.cwd, '/work/app');
});

test('translate maps idle Notification to waiting and Stop to stop', () => {
  const waiting = translate(
    JSON.stringify({ hook_event_name: 'Notification', session_id: 's1', message: 'Claude is waiting for your input' }),
  );
  assert.strictEqual(waiting.kind, 'waiting');
  const stop = translate(JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' }));
  assert.strictEqual(stop.kind, 'stop');
});

test('translate maps UserPromptSubmit to clear and rejects junk', () => {
  const clear = translate(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }));
  assert.strictEqual(clear.kind, 'clear');
  assert.strictEqual(translate('not json'), null);
  assert.strictEqual(translate(JSON.stringify({ hook_event_name: 'Stop' })), null); // no session_id
  assert.strictEqual(translate(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1' })), null);
});

test('HookServer accepts posted events and answers /health', async () => {
  const server = new HookServer({ port: 0 });
  const events = [];
  server.on('event', (event) => events.push(event));
  const ok = await server.start();
  assert.strictEqual(ok, true);
  const port = server.server.address().port;

  const post = (body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/event', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode, data }));
        },
      );
      req.on('error', reject);
      req.end(body);
    });

  const res = await post(JSON.stringify({ hook_event_name: 'Stop', session_id: 'abc' }));
  assert.strictEqual(res.status, 200);

  const health = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/health' }, (r) => {
      let data = '';
      r.on('data', (chunk) => (data += chunk));
      r.on('end', () => resolve(data));
    }).on('error', reject);
  });
  assert.match(health, /ai-keeper/);

  await post('garbage');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].sessionId, 'abc');
  assert.strictEqual(events[0].kind, 'stop');

  server.stop();
});
