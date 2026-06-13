'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const installer = require('../src/main/hookInstaller');

function tmpSettings(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-keeper-hooks-'));
  const file = path.join(dir, 'settings.json');
  if (initial !== undefined) fs.writeFileSync(file, initial);
  return file;
}

test('install creates hooks in an empty settings file and is idempotent', () => {
  const settingsFile = tmpSettings();
  const status = installer.install({ port: 43117, settingsFile });
  assert.strictEqual(status.installed, true);

  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  for (const eventName of installer.HOOK_EVENTS) {
    assert.ok(Array.isArray(settings.hooks[eventName]), `${eventName} present`);
  }

  installer.install({ port: 43117, settingsFile });
  const again = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  for (const eventName of installer.HOOK_EVENTS) {
    const markers = JSON.stringify(again.hooks[eventName]).split(installer.MARKER).length - 1;
    assert.strictEqual(markers, 1, `${eventName} has exactly one ai-keeper hook`);
  }
});

test('install preserves existing user hooks and updates the port', () => {
  const settingsFile = tmpSettings(
    JSON.stringify({
      model: 'opus',
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
      },
    }),
  );
  installer.install({ port: 50000, settingsFile });
  installer.install({ port: 50001, settingsFile });

  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.strictEqual(settings.model, 'opus');
  const flat = JSON.stringify(settings.hooks.Stop);
  assert.match(flat, /say done/);
  assert.match(flat, /50001/);
  assert.doesNotMatch(flat, /50000/);
  assert.ok(fs.existsSync(`${settingsFile}.ai-keeper.bak`), 'backup written');
});

test('uninstall removes only ai-keeper hooks', () => {
  const settingsFile = tmpSettings(
    JSON.stringify({ hooks: { Notification: [{ hooks: [{ type: 'command', command: 'notify-send hi' }] }] } }),
  );
  installer.install({ port: 43117, settingsFile });
  assert.strictEqual(installer.statusOf({ settingsFile }).installed, true);

  installer.uninstall({ settingsFile });
  const status = installer.statusOf({ settingsFile });
  assert.strictEqual(status.installed, false);

  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.match(JSON.stringify(settings.hooks.Notification), /notify-send/);
  assert.strictEqual(settings.hooks.Stop, undefined);
});

test('statusOf reports uninstalled for missing file', () => {
  const status = installer.statusOf({ settingsFile: '/nonexistent/settings.json' });
  assert.strictEqual(status.installed, false);
});

test('webHookSnippet emits HTTP hooks for every event plus the URL allowlist', () => {
  const snippet = installer.webHookSnippet({ relayUrl: 'https://ntfy.sh/my-topic' });
  assert.deepStrictEqual(snippet.allowedHttpHookUrls, ['https://ntfy.sh/my-topic']);
  for (const eventName of installer.HOOK_EVENTS) {
    const hook = snippet.hooks[eventName][0].hooks[0];
    assert.strictEqual(hook.type, 'http');
    assert.strictEqual(hook.url, 'https://ntfy.sh/my-topic');
    assert.strictEqual(hook.headers, undefined, 'no headers without a token');
  }

  const withToken = installer.webHookSnippet({ relayUrl: 'https://r.example/t', relayToken: 'secret' });
  const hook = withToken.hooks.Stop[0].hooks[0];
  assert.deepStrictEqual(hook.headers, { Authorization: 'Bearer $AI_KEEPER_RELAY_TOKEN' });
  assert.deepStrictEqual(hook.allowedEnvVars, ['AI_KEEPER_RELAY_TOKEN']);
  assert.ok(!JSON.stringify(withToken).includes('secret'), 'token value itself never appears in the snippet');
});
