'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SessionMonitor, toItem, sortItems } = require('../src/main/sessionMonitor');

const NOW = Date.now();

function writeTranscript(projectsDir, project, name, entries) {
  const dir = path.join(projectsDir, project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n'));
  return file;
}

function userEntry(sessionId, text, ts, cwd = '/work/app') {
  return {
    type: 'user',
    sessionId,
    cwd,
    uuid: `${sessionId}-u-${ts}`,
    timestamp: new Date(ts).toISOString(),
    message: { role: 'user', content: text },
  };
}

function assistantEntry(sessionId, text, ts, cwd = '/work/app') {
  return {
    type: 'assistant',
    sessionId,
    cwd,
    uuid: `${sessionId}-a-${ts}`,
    timestamp: new Date(ts).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

test('rescan discovers transcripts and list() classifies them', async () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-keeper-projects-'));
  const waiting = writeTranscript(projectsDir, '-work-app', 'waiting-1', [
    userEntry('waiting-1', 'fix the tests', NOW - 120_000),
    assistantEntry('waiting-1', 'Done. Should I also update CI config?', NOW - 60_000),
  ]);
  // Make mtime old enough to not look "working".
  const old = (NOW - 60_000) / 1000;
  fs.utimesSync(waiting, old, old);

  const fresh = writeTranscript(projectsDir, '-work-app', 'working-1', [
    userEntry('working-1', 'add dark mode', NOW - 10_000),
    assistantEntry('working-1', 'On it.', NOW - 2_000),
  ]);
  fs.utimesSync(fresh, NOW / 1000, NOW / 1000);

  const monitor = new SessionMonitor({ projectsDir, tickMs: 60_000 });
  await monitor.rescan();
  const items = monitor.list();
  monitor.stop();

  assert.strictEqual(items.length, 2);
  const byId = Object.fromEntries(items.map((i) => [i.sessionId, i]));
  assert.strictEqual(byId['waiting-1'].state, 'needs_input');
  assert.strictEqual(byId['working-1'].state, 'working');
  // needs_input sorts first
  assert.strictEqual(items[0].sessionId, 'waiting-1');

  assert.ok(monitor.getSession('waiting-1'));
  assert.strictEqual(monitor.getSession('nope'), null);
  fs.rmSync(projectsDir, { recursive: true, force: true });
});

test('hook events flip session state and clear events reset it', async () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-keeper-projects-'));
  const file = writeTranscript(projectsDir, '-work-app', 'hooked-1', [
    userEntry('hooked-1', 'deploy it', NOW - 30_000),
    assistantEntry('hooked-1', 'Deploying now.', NOW - 6_000),
  ]);
  fs.utimesSync(file, NOW / 1000, NOW / 1000); // looks "working"

  const monitor = new SessionMonitor({ projectsDir, tickMs: 60_000 });
  await monitor.rescan();
  assert.strictEqual(monitor.list()[0].state, 'working');

  monitor.applyHookEvent({
    sessionId: 'hooked-1',
    kind: 'permission',
    message: 'Claude needs your permission to use Bash',
    ts: Date.now(),
  });
  // applyHookEvent without transcriptPath emits synchronously
  let item = monitor.list()[0];
  assert.strictEqual(item.state, 'needs_input');
  assert.strictEqual(item.reason, 'permission');

  monitor.applyHookEvent({ sessionId: 'hooked-1', kind: 'clear', ts: Date.now() });
  item = monitor.list()[0];
  assert.strictEqual(item.state, 'working');

  monitor.stop();
  fs.rmSync(projectsDir, { recursive: true, force: true });
});

test('sortItems ranks attention > working > idle and caps idle sessions', () => {
  const items = [];
  for (let i = 0; i < 30; i++) {
    items.push({ sessionId: `idle-${i}`, state: 'idle', lastActivity: NOW - i * 1000 });
  }
  items.push({ sessionId: 'w', state: 'working', lastActivity: NOW });
  items.push({ sessionId: 'n', state: 'needs_input', lastActivity: NOW - 5_000 });

  const sorted = sortItems(items);
  assert.strictEqual(sorted[0].sessionId, 'n');
  assert.strictEqual(sorted[1].sessionId, 'w');
  assert.strictEqual(sorted.filter((i) => i.state === 'idle').length, 20);
});

test('toItem carries the fields the renderer needs', () => {
  const item = toItem(
    {
      sessionId: 's1',
      filePath: '/tmp/s1.jsonl',
      cwd: '/work/payments-service',
      title: 'Fix checkout',
      mtimeMs: NOW - 60_000,
      lastEntry: { role: 'assistant', ts: NOW - 60_000 },
      lastUser: null,
      lastAssistant: { text: 'Which fix do you prefer?', ts: NOW - 60_000, uuid: 'a9' },
      pendingToolUse: null,
      messageCount: 4,
    },
    null,
    NOW,
  );
  assert.strictEqual(item.project, 'payments-service');
  assert.strictEqual(item.state, 'needs_input');
  assert.strictEqual(item.lastAssistantUuid, 'a9');
  assert.strictEqual(item.lastAssistantText, 'Which fix do you prefer?');
});
