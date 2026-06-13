'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseLines, reduceEntries, parseFile, textFromContent, truncate } = require('../src/main/transcript');

function line(obj) {
  return JSON.stringify(obj);
}

const T0 = '2026-06-13T10:00:00.000Z';
const T1 = '2026-06-13T10:00:05.000Z';
const T2 = '2026-06-13T10:00:10.000Z';

function sampleTranscript() {
  return [
    line({ type: 'summary', summary: 'AWS SSO login credentials task', leafUuid: 'a2' }),
    line({
      type: 'user',
      sessionId: 's1',
      cwd: '/work/infra',
      uuid: 'u1',
      timestamp: T0,
      message: { role: 'user', content: 'Set up AWS SSO login for the deploy scripts' },
    }),
    line({
      type: 'assistant',
      sessionId: 's1',
      cwd: '/work/infra',
      uuid: 'a1',
      timestamp: T1,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me look at the config.' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/home/me/.aws/config' } },
        ],
      },
    }),
    line({
      type: 'user',
      sessionId: 's1',
      cwd: '/work/infra',
      uuid: 'u2',
      timestamp: T1,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'profiles: ...' }] },
    }),
    line({
      type: 'assistant',
      sessionId: 's1',
      cwd: '/work/infra',
      uuid: 'a2',
      timestamp: T2,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Which profile should I use: staging-admin or a new one?' }],
      },
    }),
  ].join('\n');
}

test('parseLines skips blank and partial lines', () => {
  const entries = parseLines('\n{"a":1}\n{"broken\n{"b":2}\n');
  assert.deepStrictEqual(entries, [{ a: 1 }, { b: 2 }]);
});

test('textFromContent handles strings and block arrays', () => {
  assert.strictEqual(textFromContent('hi'), 'hi');
  assert.strictEqual(
    textFromContent([
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'hello' },
      { type: 'tool_use', name: 'Bash', input: {} },
    ]),
    'hello',
  );
  assert.strictEqual(textFromContent(undefined), '');
});

test('reduceEntries extracts title, last messages, and tail', () => {
  const session = reduceEntries(parseLines(sampleTranscript()), '/tmp/s1.jsonl');
  assert.strictEqual(session.sessionId, 's1');
  assert.strictEqual(session.cwd, '/work/infra');
  assert.strictEqual(session.title, 'AWS SSO login credentials task');
  assert.match(session.lastAssistant.text, /Which profile/);
  assert.strictEqual(session.lastAssistant.uuid, 'a2');
  assert.strictEqual(session.lastUser.text, 'Set up AWS SSO login for the deploy scripts');
  assert.strictEqual(session.lastEntry.role, 'assistant');
  // The tool_use was answered by a tool_result, so nothing is pending.
  assert.strictEqual(session.pendingToolUse, null);
  assert.ok(session.tail.length >= 3);
  assert.strictEqual(session.tail.at(-1).role, 'assistant');
});

test('reduceEntries keeps pending tool_use when no result followed', () => {
  const raw = [
    line({
      type: 'user',
      sessionId: 's2',
      cwd: '/work/blog',
      uuid: 'u1',
      timestamp: T0,
      message: { role: 'user', content: 'Clean up the build dir' },
    }),
    line({
      type: 'assistant',
      sessionId: 's2',
      cwd: '/work/blog',
      uuid: 'a1',
      timestamp: T1,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'rm -rf _site' } }],
      },
    }),
  ].join('\n');
  const session = reduceEntries(parseLines(raw), null);
  assert.deepStrictEqual(session.pendingToolUse, { name: 'Bash', input: 'rm -rf _site' });
  assert.strictEqual(session.lastEntry.role, 'assistant');
});

test('reduceEntries ignores sidechain and meta entries', () => {
  const raw = [
    line({
      type: 'user',
      sessionId: 's3',
      uuid: 'u1',
      timestamp: T0,
      message: { role: 'user', content: 'main thread' },
    }),
    line({
      type: 'assistant',
      sessionId: 's3',
      uuid: 'a1',
      isSidechain: true,
      timestamp: T1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'sidechain reply' }] },
    }),
    line({
      type: 'user',
      sessionId: 's3',
      uuid: 'u2',
      isMeta: true,
      timestamp: T1,
      message: { role: 'user', content: 'meta' },
    }),
  ].join('\n');
  const session = reduceEntries(parseLines(raw), null);
  assert.strictEqual(session.lastAssistant, null);
  assert.strictEqual(session.lastEntry.role, 'user');
  assert.strictEqual(session.messageCount, 1);
});

test('title falls back to first user message', () => {
  const raw = line({
    type: 'user',
    sessionId: 's4',
    uuid: 'u1',
    timestamp: T0,
    message: { role: 'user', content: 'Fix the flaky checkout tests that fail in CI' },
  });
  const session = reduceEntries(parseLines(raw), null);
  assert.strictEqual(session.title, 'Fix the flaky checkout tests that fail in CI');
});

test('truncate collapses whitespace and bounds length', () => {
  assert.strictEqual(truncate('a  b\n\nc', 10), 'a b c');
  assert.strictEqual(truncate('x'.repeat(20), 10).length, 10);
});

test('parseFile reads a transcript from disk and fills session id from filename', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-keeper-test-'));
  const file = path.join(dir, 'abc-123.jsonl');
  fs.writeFileSync(file, sampleTranscript());
  const session = await parseFile(file);
  assert.strictEqual(session.sessionId, 's1'); // from entries, not filename
  assert.ok(session.mtimeMs > 0);

  const empty = path.join(dir, 'empty-id.jsonl');
  fs.writeFileSync(empty, '');
  const emptySession = await parseFile(empty);
  assert.strictEqual(emptySession.sessionId, 'empty-id');
  fs.rmSync(dir, { recursive: true, force: true });
});
