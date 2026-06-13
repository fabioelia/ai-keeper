'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { PROJECTS_DIR, TICK_MS, STALE_AFTER_MS } = require('./constants');
const transcript = require('./transcript');
const { computeStatus } = require('./status');
const { classifyTool } = require('./policy');

const MAX_IDLE_LISTED = 20;

// Watches ~/.claude/projects/**/*.jsonl and maintains the list of sessions.
// Uses fs.watch(recursive) when available plus a periodic rescan, so it works
// without native dependencies and also catches the "working -> waiting"
// transition, which happens with no file event at all.
class SessionMonitor extends EventEmitter {
  constructor({ projectsDir = PROJECTS_DIR, tickMs = TICK_MS } = {}) {
    super();
    this.projectsDir = projectsDir;
    this.tickMs = tickMs;
    this.sessions = new Map(); // filePath -> parsed session
    this.hookStates = new Map(); // sessionId -> { kind, message, ts, transcriptPath }
    this.parseTimers = new Map(); // filePath -> debounce timer
    this.watcher = null;
    this.tickTimer = null;
    this.scanning = false;
    this.stats = { projectsDir, dirExists: false, transcriptCount: 0, lastScanAt: null };
  }

  async start() {
    await this.rescan();
    try {
      this.watcher = fs.watch(this.projectsDir, { recursive: true }, (_event, fileName) => {
        if (!fileName || !fileName.endsWith('.jsonl')) return;
        this.scheduleParse(path.join(this.projectsDir, fileName));
      });
      this.watcher.on('error', () => {});
    } catch {
      // Recursive watch unavailable (or projects dir missing); rescans cover it.
    }
    this.tickTimer = setInterval(() => {
      this.rescan().catch(() => {});
    }, this.tickMs);
    if (this.tickTimer.unref) this.tickTimer.unref();
  }

  stop() {
    if (this.watcher) this.watcher.close();
    if (this.tickTimer) clearInterval(this.tickTimer);
    for (const timer of this.parseTimers.values()) clearTimeout(timer);
    this.parseTimers.clear();
  }

  // Hook events (from hookServer) are keyed by sessionId and override heuristics.
  applyHookEvent(event) {
    if (!event || !event.sessionId) return;
    if (event.kind === 'clear') {
      this.hookStates.delete(event.sessionId);
    } else {
      this.hookStates.set(event.sessionId, event);
    }
    if (event.transcriptPath) this.scheduleParse(event.transcriptPath);
    else this.emitUpdate();
  }

  scheduleParse(filePath) {
    const existing = this.parseTimers.get(filePath);
    if (existing) clearTimeout(existing);
    this.parseTimers.set(
      filePath,
      setTimeout(() => {
        this.parseTimers.delete(filePath);
        this.parseOne(filePath).then(() => this.emitUpdate()).catch(() => {});
      }, 250),
    );
  }

  async parseOne(filePath) {
    try {
      const session = await transcript.parseFile(filePath);
      this.sessions.set(filePath, session);
    } catch {
      this.sessions.delete(filePath); // deleted or unreadable
    }
  }

  getStats() {
    return { ...this.stats };
  }

  async rescan() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const { files, dirExists } = await listTranscripts(this.projectsDir);
      this.stats = {
        projectsDir: this.projectsDir,
        dirExists,
        transcriptCount: files.length,
        lastScanAt: Date.now(),
      };
      const seen = new Set(files.map((f) => f.path));
      for (const known of this.sessions.keys()) {
        if (!seen.has(known)) this.sessions.delete(known);
      }
      const cutoff = Date.now() - STALE_AFTER_MS * 7;
      for (const file of files) {
        if (file.mtimeMs < cutoff) continue; // skip ancient transcripts entirely
        const known = this.sessions.get(file.path);
        if (!known || known.mtimeMs !== file.mtimeMs) {
          await this.parseOne(file.path);
        }
      }
      this.emitUpdate();
    } finally {
      this.scanning = false;
    }
  }

  emitUpdate() {
    this.emit('update', this.list());
  }

  list(now = Date.now()) {
    const items = [];
    for (const session of this.sessions.values()) {
      if (!session.sessionId || session.messageCount === 0) continue;
      const hookState = this.hookStates.get(session.sessionId) || null;
      items.push(toItem(session, hookState, now));
    }
    return sortItems(items);
  }

  // The full parsed session (with conversation tail) for the suggestion model.
  getSession(sessionId) {
    for (const session of this.sessions.values()) {
      if (session.sessionId === sessionId) return session;
    }
    return null;
  }
}

// The wire shape the renderer consumes for one session.
function toItem(session, hookState, now = Date.now(), rules = {}) {
  const st = computeStatus(session, hookState, now);
  // Triage hint only: classify the pending permission request so the panel can
  // flag which waiting sessions are safe reads vs. destructive actions. This
  // never approves anything — it just ranks attention.
  const risk = session.pendingToolUse ? classifyTool(session.pendingToolUse, rules) : null;
  return {
    sessionId: session.sessionId,
    filePath: session.filePath,
    cwd: session.cwd,
    project: session.cwd ? path.basename(session.cwd) : 'unknown',
    title: session.title,
    state: st.state,
    reason: st.reason,
    statusMessage: st.message,
    needsAttention: st.needsAttention,
    lastActivity: st.lastActivity,
    lastAssistantText: session.lastAssistant ? transcript.truncate(session.lastAssistant.text, 280) : null,
    lastAssistantUuid: session.lastAssistant ? session.lastAssistant.uuid : null,
    pendingToolUse: session.pendingToolUse,
    risk: risk ? risk.risk : null,
    riskReason: risk ? risk.reason : null,
  };
}

function sortItems(items) {
  const rank = { needs_input: 0, working: 1, idle: 2 };
  items.sort((a, b) => rank[a.state] - rank[b.state] || b.lastActivity - a.lastActivity);
  const idle = items.filter((i) => i.state === 'idle');
  if (idle.length > MAX_IDLE_LISTED) {
    const keep = new Set(idle.slice(0, MAX_IDLE_LISTED));
    return items.filter((i) => i.state !== 'idle' || keep.has(i));
  }
  return items;
}

async function listTranscripts(projectsDir) {
  const out = [];
  let projectDirs;
  try {
    projectDirs = await fs.promises.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return { files: out, dirExists: false };
  }
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const full = path.join(projectsDir, dir.name);
    let files;
    try {
      files = await fs.promises.readdir(full, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      const filePath = path.join(full, file.name);
      try {
        const stat = await fs.promises.stat(filePath);
        out.push({ path: filePath, mtimeMs: stat.mtimeMs });
      } catch {
        // raced with deletion
      }
    }
  }
  return { files: out, dirExists: true };
}

module.exports = { SessionMonitor, toItem, sortItems };
