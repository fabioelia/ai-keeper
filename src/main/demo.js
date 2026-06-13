'use strict';

// Demo sessions for `npm run demo` (AI_KEEPER_DEMO=1): lets you see the panel
// without a populated ~/.claude/projects dir. Suggestions still go through
// Gemma when Ollama is up; the `fallback` field is used when it is not.

function demoSessions(now = Date.now()) {
  return [
    {
      sessionId: 'demo-aws-sso',
      filePath: null,
      cwd: '/home/you/work/infra-tools',
      title: 'AWS SSO login credentials task',
      mtimeMs: now - 90_000,
      messageCount: 6,
      lastEntry: { role: 'assistant', ts: now - 90_000 },
      lastUser: { text: 'Set up AWS SSO login for the deploy scripts', ts: now - 400_000, uuid: 'demo-u1' },
      lastAssistant: {
        text:
          'I added an sso-session block to ~/.aws/config and wired the deploy scripts to use it. ' +
          'Before I can run `aws sso login`, I need to know which profile to authenticate: the existing ' +
          '`staging-admin` profile, or a new profile for production?',
        ts: now - 90_000,
        uuid: 'demo-a1',
      },
      pendingToolUse: null,
      tail: [
        { role: 'user', text: 'Set up AWS SSO login for the deploy scripts' },
        { role: 'assistant', text: '[requested tool Read: ~/.aws/config]' },
        { role: 'tool', text: '[tool result returned]' },
        {
          role: 'assistant',
          text:
            'I added an sso-session block to ~/.aws/config and wired the deploy scripts to use it. ' +
            'Before I can run `aws sso login`, I need to know which profile to authenticate: the existing ' +
            '`staging-admin` profile, or a new profile for production?',
        },
      ],
      fallback: {
        summary:
          'The agent finished wiring AWS SSO config and is asking which profile to log in with before running `aws sso login`.',
        options: ['Use the existing staging-admin profile', 'Create a new production profile'],
      },
    },
    {
      sessionId: 'demo-payments',
      filePath: null,
      cwd: '/home/you/work/payments-service',
      title: 'Fix flaky checkout integration tests',
      mtimeMs: now - 3_000,
      messageCount: 14,
      lastEntry: { role: 'assistant', ts: now - 3_000, toolUses: true },
      lastUser: { text: 'The checkout tests fail randomly in CI, can you fix them?', ts: now - 600_000, uuid: 'demo-u2' },
      lastAssistant: null,
      pendingToolUse: { name: 'Bash', input: 'npm test -- --runInBand checkout' },
      tail: [
        { role: 'user', text: 'The checkout tests fail randomly in CI, can you fix them?' },
        { role: 'assistant', text: '[requested tool Bash: npm test -- --runInBand checkout]' },
      ],
    },
    {
      sessionId: 'demo-blog',
      filePath: null,
      cwd: '/home/you/personal/blog',
      title: 'Migrate blog from Jekyll to Astro',
      mtimeMs: now - 50_000,
      messageCount: 9,
      lastEntry: { role: 'assistant', ts: now - 50_000, toolUses: true },
      lastUser: { text: 'Migrate my blog to Astro, keep the URLs stable', ts: now - 900_000, uuid: 'demo-u3' },
      lastAssistant: {
        text: 'The scaffold is ready. I need to delete the old _site build directory before generating redirects.',
        ts: now - 50_000,
        uuid: 'demo-a3',
      },
      pendingToolUse: { name: 'Bash', input: 'rm -rf _site' },
      tail: [
        { role: 'user', text: 'Migrate my blog to Astro, keep the URLs stable' },
        { role: 'assistant', text: 'The scaffold is ready. I need to delete the old _site build directory before generating redirects.' },
        { role: 'assistant', text: '[requested tool Bash: rm -rf _site]' },
      ],
      fallback: {
        summary: 'The agent scaffolded the Astro site and wants permission to delete the old _site build directory.',
        options: ['Approve the deletion', 'Archive _site somewhere first'],
      },
    },
  ];
}

const { EventEmitter } = require('events');
const { toItem, sortItems } = require('./sessionMonitor');

// Drop-in replacement for SessionMonitor backed by the fake sessions above.
// The "payments" session has its mtime refreshed on every tick so it stays in
// the working state and the panel shows all three states at once.
class DemoMonitor extends EventEmitter {
  constructor() {
    super();
    this.sessions = demoSessions();
    this.hookStates = new Map();
    this.timer = null;
  }

  async start() {
    this.timer = setInterval(() => {
      const working = this.sessions.find((s) => s.sessionId === 'demo-payments');
      if (working) working.mtimeMs = Date.now() - 2_000;
      this.emitUpdate();
    }, 5_000);
    if (this.timer.unref) this.timer.unref();
    this.emitUpdate();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  applyHookEvent(event) {
    if (!event || !event.sessionId) return;
    if (event.kind === 'clear') this.hookStates.delete(event.sessionId);
    else this.hookStates.set(event.sessionId, event);
    this.emitUpdate();
  }

  emitUpdate() {
    this.emit('update', this.list());
  }

  list(now = Date.now()) {
    return sortItems(
      this.sessions.map((s) => toItem(s, this.hookStates.get(s.sessionId) || null, now)),
    );
  }

  getSession(sessionId) {
    return this.sessions.find((s) => s.sessionId === sessionId) || null;
  }

  getStats() {
    return {
      projectsDir: '(demo data — not reading real sessions)',
      dirExists: true,
      transcriptCount: this.sessions.length,
      lastScanAt: Date.now(),
    };
  }
}

module.exports = { demoSessions, DemoMonitor };
