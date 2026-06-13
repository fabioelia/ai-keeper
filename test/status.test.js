'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { computeStatus } = require('../src/main/status');
const { ACTIVE_WINDOW_MS, STALE_AFTER_MS } = require('../src/main/constants');

const NOW = 1_800_000_000_000;

function session(overrides = {}) {
  return {
    sessionId: 's1',
    mtimeMs: NOW - 60_000,
    lastEntry: { role: 'assistant', ts: NOW - 60_000 },
    lastUser: { text: 'do the thing', ts: NOW - 120_000, uuid: 'u1' },
    lastAssistant: { text: 'Which option?', ts: NOW - 60_000, uuid: 'a1' },
    pendingToolUse: null,
    ...overrides,
  };
}

test('fresh mtime means working', () => {
  const st = computeStatus(session({ mtimeMs: NOW - 2_000 }), null, NOW);
  assert.strictEqual(st.state, 'working');
  assert.strictEqual(st.needsAttention, false);
});

test('quiet transcript ending on an assistant turn needs input', () => {
  const st = computeStatus(session(), null, NOW);
  assert.strictEqual(st.state, 'needs_input');
  assert.strictEqual(st.reason, 'reply');
  assert.strictEqual(st.message, 'Waiting for next steps.');
});

test('pending tool use without hooks reads as a permission prompt', () => {
  const st = computeStatus(
    session({ pendingToolUse: { name: 'Bash', input: 'rm -rf _site' }, lastAssistant: null }),
    null,
    NOW,
  );
  assert.strictEqual(st.state, 'needs_input');
  assert.strictEqual(st.reason, 'permission');
  assert.match(st.message, /Bash/);
});

test('quiet transcript ending on a user turn is idle (no response in progress)', () => {
  const st = computeStatus(session({ lastEntry: { role: 'user', ts: NOW - 60_000 } }), null, NOW);
  assert.strictEqual(st.state, 'idle');
});

test('very old sessions are idle regardless of last role', () => {
  const old = NOW - STALE_AFTER_MS - 1;
  const st = computeStatus(session({ mtimeMs: old, lastEntry: { role: 'assistant', ts: old } }), null, NOW);
  assert.strictEqual(st.state, 'idle');
});

test('permission hook event forces needs_input with the hook message', () => {
  const hook = { kind: 'permission', message: 'Claude needs your permission to use Bash', ts: NOW - 5_000 };
  const st = computeStatus(session({ mtimeMs: NOW - 1_000 }), hook, NOW);
  assert.strictEqual(st.state, 'needs_input');
  assert.strictEqual(st.reason, 'permission');
  assert.match(st.message, /permission to use Bash/);
});

test('stop hook event marks the session as waiting', () => {
  const hook = { kind: 'stop', ts: NOW - 5_000 };
  const st = computeStatus(session({ mtimeMs: NOW - 1_000 }), hook, NOW);
  assert.strictEqual(st.state, 'needs_input');
  assert.strictEqual(st.reason, 'reply');
});

test('hook state is superseded once the user replies after it', () => {
  const hook = { kind: 'stop', ts: NOW - 60_000 };
  const st = computeStatus(
    session({
      mtimeMs: NOW - 2_000,
      lastUser: { text: 'continue', ts: NOW - 10_000, uuid: 'u2' },
      lastEntry: { role: 'user', ts: NOW - 10_000 },
    }),
    hook,
    NOW,
  );
  assert.strictEqual(st.state, 'working'); // fresh mtime, Claude is responding
});

test('permission hook superseded by a newer tool result', () => {
  const hook = { kind: 'permission', message: 'permission to use Bash', ts: NOW - 60_000 };
  const st = computeStatus(
    session({
      mtimeMs: NOW - 30_000,
      lastEntry: { role: 'user', ts: NOW - 30_000, toolResult: true },
      lastAssistant: null,
    }),
    hook,
    NOW,
  );
  assert.strictEqual(st.state, 'idle');
});

test('responded marker turns the session idle after the active window', () => {
  const hook = { kind: 'responded', ts: NOW - 30_000 };
  const st = computeStatus(session(), hook, NOW);
  assert.strictEqual(st.state, 'idle');
  const stFresh = computeStatus(session({ mtimeMs: NOW - ACTIVE_WINDOW_MS + 1_000 }), hook, NOW);
  assert.strictEqual(stFresh.state, 'working');
});
