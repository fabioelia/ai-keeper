'use strict';

const { ACTIVE_WINDOW_MS, STALE_AFTER_MS } = require('./constants');

// Session states surfaced in the panel:
//   working      - Claude is actively producing output.
//   needs_input  - the agent finished a turn or is blocked on a permission
//                  prompt; the human has to respond. These are the
//                  notification items.
//   idle         - nothing happening; shown as history.
//
// `hookState` comes from Claude Code hook events (see hookServer.js) and is
// authoritative when present. Without hooks we fall back to transcript
// heuristics: a fresh mtime means Claude is writing; a transcript whose last
// entry is an assistant turn and has gone quiet means Claude is waiting.

function computeStatus(session, hookState, now = Date.now()) {
  const lastActivity = session.mtimeMs || entryTs(session.lastEntry) || 0;
  const age = now - lastActivity;

  if (hookState && !hookSuperseded(session, hookState)) {
    if (hookState.kind === 'permission') {
      return status('needs_input', 'permission', hookState.message || permissionMessage(session), lastActivity);
    }
    if (hookState.kind === 'waiting' || hookState.kind === 'stop') {
      return status('needs_input', 'reply', 'Waiting for next steps.', lastActivity);
    }
    // Set locally after the user replies through ai-keeper itself.
    if (hookState.kind === 'responded' && age > ACTIVE_WINDOW_MS) {
      return status('idle', null, 'You responded; continuation runs in a new session.', lastActivity);
    }
  }

  if (age <= ACTIVE_WINDOW_MS) {
    return status('working', null, workingMessage(session), lastActivity);
  }

  if (age > STALE_AFTER_MS) {
    return status('idle', null, 'No recent activity.', lastActivity);
  }

  const last = session.lastEntry;
  if (last && last.role === 'assistant') {
    if (session.pendingToolUse) {
      return status('needs_input', 'permission', permissionMessage(session), lastActivity);
    }
    return status('needs_input', 'reply', 'Waiting for next steps.', lastActivity);
  }

  // Last entry was the user (or a tool result) and nothing has been written
  // since: either the CLI exited mid-turn or the session was abandoned.
  return status('idle', null, 'No response in progress.', lastActivity);
}

function hookSuperseded(session, hookState) {
  // A user entry newer than the hook event means the human already replied.
  const lastUserTs = session.lastUser ? session.lastUser.ts : null;
  const lastEntry = session.lastEntry;
  if (lastUserTs && hookState.ts && lastUserTs > hookState.ts) return true;
  // For permission prompts, a tool result means the tool ran (was approved).
  if (hookState.kind === 'permission' && lastEntry && lastEntry.role === 'user' && lastEntry.toolResult) {
    return entryTs(lastEntry) == null || !hookState.ts || entryTs(lastEntry) > hookState.ts;
  }
  return false;
}

function permissionMessage(session) {
  if (session.pendingToolUse) {
    return `Needs permission to run ${session.pendingToolUse.name}: ${session.pendingToolUse.input}`;
  }
  return 'Needs permission to continue.';
}

function workingMessage(session) {
  if (session.pendingToolUse) {
    return `Running ${session.pendingToolUse.name}…`;
  }
  return 'Working…';
}

function entryTs(entry) {
  return entry && Number.isFinite(entry.ts) ? entry.ts : null;
}

function status(state, reason, message, lastActivity) {
  return { state, reason, message, lastActivity, needsAttention: state === 'needs_input' };
}

module.exports = { computeStatus };
