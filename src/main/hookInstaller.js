'use strict';

const fs = require('fs');
const { SETTINGS_FILE } = require('./constants');

const MARKER = '# ai-keeper';
const HOOK_EVENTS = ['Notification', 'Stop', 'UserPromptSubmit'];

// Claude Code hooks let external tools observe sessions reliably (file
// watching alone cannot tell "still thinking" from "waiting on you" until a
// timeout passes). We register a command hook that forwards the hook's stdin
// JSON to the local HookServer. The trailing `|| true` keeps Claude Code
// unaffected when ai-keeper is not running, and the marker comment makes the
// install idempotent and easy to spot in settings.json.

function hookCommand(port) {
  return (
    `curl -s --max-time 3 -X POST http://127.0.0.1:${port}/event ` +
    `-H "Content-Type: application/json" --data-binary @- >/dev/null 2>&1 || true ${MARKER}`
  );
}

function readSettings(settingsFile) {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {
    return {};
  }
}

function isInstalled(settings, eventName) {
  const groups = settings.hooks && settings.hooks[eventName];
  if (!Array.isArray(groups)) return false;
  return groups.some(
    (group) =>
      Array.isArray(group.hooks) &&
      group.hooks.some((h) => typeof h.command === 'string' && h.command.includes(MARKER)),
  );
}

function install({ port, settingsFile = SETTINGS_FILE }) {
  const settings = readSettings(settingsFile);
  const command = hookCommand(port);
  settings.hooks = settings.hooks || {};

  let changed = false;
  for (const eventName of HOOK_EVENTS) {
    const groups = Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : [];
    // Refresh our entry (the port may have changed); leave everything else alone.
    const kept = groups
      .map((group) => {
        if (!Array.isArray(group.hooks)) return group;
        const hooks = group.hooks.filter(
          (h) => !(typeof h.command === 'string' && h.command.includes(MARKER)),
        );
        return { ...group, hooks };
      })
      .filter((group) => !Array.isArray(group.hooks) || group.hooks.length > 0);
    kept.push({ hooks: [{ type: 'command', command }] });
    settings.hooks[eventName] = kept;
    changed = true;
  }

  if (changed) {
    if (fs.existsSync(settingsFile)) {
      fs.copyFileSync(settingsFile, `${settingsFile}.ai-keeper.bak`);
    }
    fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  }
  return statusOf({ settingsFile });
}

function uninstall({ settingsFile = SETTINGS_FILE } = {}) {
  const settings = readSettings(settingsFile);
  if (!settings.hooks) return statusOf({ settingsFile });
  for (const eventName of HOOK_EVENTS) {
    const groups = settings.hooks[eventName];
    if (!Array.isArray(groups)) continue;
    settings.hooks[eventName] = groups
      .map((group) => {
        if (!Array.isArray(group.hooks)) return group;
        return {
          ...group,
          hooks: group.hooks.filter(
            (h) => !(typeof h.command === 'string' && h.command.includes(MARKER)),
          ),
        };
      })
      .filter((group) => !Array.isArray(group.hooks) || group.hooks.length > 0);
    if (settings.hooks[eventName].length === 0) delete settings.hooks[eventName];
  }
  fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  return statusOf({ settingsFile });
}

function statusOf({ settingsFile = SETTINGS_FILE } = {}) {
  const settings = readSettings(settingsFile);
  const installed = {};
  for (const eventName of HOOK_EVENTS) {
    installed[eventName] = isInstalled(settings, eventName);
  }
  return {
    installed: HOOK_EVENTS.every((eventName) => installed[eventName]),
    events: installed,
    settingsFile,
  };
}

// Settings snippet for repos used with Claude Code on the web. Web containers
// cannot run command hooks, but HTTP hooks POST the same payload to a relay
// the local panel subscribes to. Commit this into the repo's
// .claude/settings.json and allow the relay domain in the web environment's
// network settings.
function webHookSnippet({ relayUrl, relayToken } = {}) {
  const hook = {
    type: 'http',
    url: relayUrl,
    timeout: 10,
  };
  if (relayToken) {
    hook.headers = { Authorization: 'Bearer $AI_KEEPER_RELAY_TOKEN' };
    hook.allowedEnvVars = ['AI_KEEPER_RELAY_TOKEN'];
  }
  const snippet = { hooks: {}, allowedHttpHookUrls: [relayUrl] };
  for (const eventName of HOOK_EVENTS) {
    snippet.hooks[eventName] = [{ matcher: '', hooks: [{ ...hook }] }];
  }
  return snippet;
}

module.exports = { install, uninstall, statusOf, hookCommand, webHookSnippet, HOOK_EVENTS, MARKER };
