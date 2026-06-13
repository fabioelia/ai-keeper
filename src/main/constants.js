'use strict';

const os = require('os');
const path = require('path');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');

// A transcript written to within this window means Claude is actively working.
const ACTIVE_WINDOW_MS = 12_000;
// Sessions with no activity for longer than this are shown as history, not attention items.
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
// How often the monitor re-evaluates session ages (working -> waiting transitions).
const TICK_MS = 5_000;
// Max bytes read from the end of large transcript files.
const TRANSCRIPT_TAIL_BYTES = 768 * 1024;

const DEFAULT_SETTINGS = {
  ollamaUrl: 'http://127.0.0.1:11434',
  model: 'gemma3:4b',
  hookPort: 43117,
  claudePath: 'claude',
  autoSuggest: true,
  notifications: true,
};

module.exports = {
  CLAUDE_DIR,
  PROJECTS_DIR,
  SETTINGS_FILE,
  ACTIVE_WINDOW_MS,
  STALE_AFTER_MS,
  TICK_MS,
  TRANSCRIPT_TAIL_BYTES,
  DEFAULT_SETTINGS,
};
