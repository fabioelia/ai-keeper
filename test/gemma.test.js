'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const gemma = require('../src/main/gemma');

const session = {
  cwd: '/work/infra',
  title: 'AWS SSO login credentials task',
  statusContext: 'The agent finished its turn and is waiting for the next instruction.',
  tail: [
    { role: 'user', text: 'Set up AWS SSO login' },
    { role: 'assistant', text: 'Which profile should I use: staging-admin or a new one?' },
  ],
  lastAssistant: { text: 'Which profile should I use: staging-admin or a new one? I can also list them.', uuid: 'a1' },
  pendingToolUse: null,
};

test('buildMessages includes context and conversation turns', () => {
  const messages = gemma.buildMessages(session);
  assert.strictEqual(messages.length, 2);
  assert.strictEqual(messages[0].role, 'system');
  assert.match(messages[1].content, /AWS SSO login credentials task/);
  assert.match(messages[1].content, /AGENT: Which profile/);
  assert.match(messages[1].content, /HUMAN: Set up AWS SSO login/);
  assert.match(messages[1].content, /Status: The agent finished its turn/);
});

test('parseResponse accepts clean JSON and fenced JSON, rejects junk', () => {
  const clean = gemma.parseResponse('{"summary":"The agent asks which profile.","options":["Use staging-admin","List profiles first"]}');
  assert.strictEqual(clean.options.length, 2);

  const fenced = gemma.parseResponse('```json\n{"summary":"S","options":["a","b","c"]}\n```');
  assert.strictEqual(fenced.summary, 'S');
  assert.strictEqual(fenced.options.length, 2, 'capped at two options');

  assert.strictEqual(gemma.parseResponse('no json here'), null);
  assert.strictEqual(gemma.parseResponse('{"summary":"S","options":[]}'), null);
  assert.strictEqual(gemma.parseResponse(undefined), null);
});

test('fallbackSuggestion summarizes the last reply and adapts to permissions', () => {
  const plain = gemma.fallbackSuggestion(session);
  assert.strictEqual(plain.source, 'fallback');
  assert.match(plain.summary, /^The agent replied with: Which profile/);
  assert.strictEqual(plain.options.length, 2);

  const perm = gemma.fallbackSuggestion({ ...session, pendingToolUse: { name: 'Bash', input: 'rm -rf _site' } });
  assert.match(perm.options[0], /Approve/i);

  const canned = gemma.fallbackSuggestion({ ...session, fallback: { summary: 'S', options: ['x', 'y'] } });
  assert.strictEqual(canned.summary, 'S');
});

test('suggest posts to Ollama and parses the structured reply', async () => {
  let captured = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      captured = { url: req.url, body: JSON.parse(body) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          message: {
            role: 'assistant',
            content: '{"summary":"The agent wants a profile choice.","options":["Use staging-admin","Create a prod profile"]}',
          },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const result = await gemma.suggest(session, { ollamaUrl: `http://127.0.0.1:${port}`, model: 'gemma3:4b' });
  assert.strictEqual(result.source, 'gemma');
  assert.strictEqual(result.options.length, 2);
  assert.strictEqual(captured.url, '/api/chat');
  assert.strictEqual(captured.body.model, 'gemma3:4b');
  assert.strictEqual(captured.body.stream, false);
  assert.strictEqual(captured.body.format.type, 'object');

  server.close();
});

test('suggest rejects when Ollama is unreachable', async () => {
  await assert.rejects(
    gemma.suggest(session, { ollamaUrl: 'http://127.0.0.1:1', model: 'gemma3:4b', timeoutMs: 3000 }),
  );
});

test('ping reports model availability', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'gemma3:4b' }, { name: 'llama3:8b' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const status = await gemma.ping({ ollamaUrl: `http://127.0.0.1:${port}`, model: 'gemma3:4b' });
  assert.deepStrictEqual({ reachable: status.reachable, hasModel: status.hasModel }, { reachable: true, hasModel: true });

  const missing = await gemma.ping({ ollamaUrl: `http://127.0.0.1:${port}`, model: 'qwen3:4b' });
  assert.strictEqual(missing.hasModel, false);

  const down = await gemma.ping({ ollamaUrl: 'http://127.0.0.1:1', model: 'gemma3:4b' });
  assert.strictEqual(down.reachable, false);

  server.close();
});
