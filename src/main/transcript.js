'use strict';

const fs = require('fs');
const path = require('path');
const { TRANSCRIPT_TAIL_BYTES } = require('./constants');

// Claude Code writes one JSON object per line. Entries we care about:
//   { type: 'user',      message: { role, content }, timestamp, sessionId, cwd, uuid, isMeta?, isSidechain? }
//   { type: 'assistant', message: { role, content: [blocks] }, timestamp, sessionId, cwd, uuid }
//   { type: 'summary',   summary: 'Conversation title', leafUuid }
// Content is either a plain string or an array of blocks
// ({ type: 'text' | 'thinking' | 'tool_use' | 'tool_result', ... }).

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function toolUsesFromContent(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block && block.type === 'tool_use')
    .map((block) => ({
      name: block.name || 'tool',
      input: compactToolInput(block.input),
    }));
}

function compactToolInput(input) {
  if (input == null) return '';
  let text;
  if (typeof input === 'string') {
    text = input;
  } else if (typeof input.command === 'string') {
    text = input.command;
  } else if (typeof input.file_path === 'string') {
    text = input.file_path;
  } else {
    try {
      text = JSON.stringify(input);
    } catch {
      text = String(input);
    }
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function hasToolResult(content) {
  return Array.isArray(content) && content.some((block) => block && block.type === 'tool_result');
}

function parseLines(raw) {
  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Partial line (file read mid-write) or tail cut a line in half; skip it.
    }
  }
  return entries;
}

// Reduce raw JSONL entries into the session shape the rest of the app consumes.
function reduceEntries(entries, filePath) {
  const session = {
    filePath: filePath || null,
    sessionId: null,
    cwd: null,
    title: null,
    lastUser: null,
    lastAssistant: null,
    lastEntry: null,
    pendingToolUse: null,
    tail: [],
    messageCount: 0,
  };

  let firstUserText = null;
  let lastSummary = null;

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;

    if (entry.type === 'summary' && typeof entry.summary === 'string') {
      lastSummary = entry.summary;
      continue;
    }
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    if (entry.isSidechain || entry.isMeta) continue;

    const message = entry.message || {};
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    const when = Number.isFinite(ts) ? ts : null;
    if (entry.sessionId) session.sessionId = entry.sessionId;
    if (entry.cwd) session.cwd = entry.cwd;

    if (entry.type === 'user') {
      const text = textFromContent(message.content);
      const toolResult = hasToolResult(message.content);
      if (text && !firstUserText) firstUserText = text;
      session.lastEntry = { role: 'user', ts: when, toolResult };
      if (text) {
        session.lastUser = { text, ts: when, uuid: entry.uuid || null };
        session.tail.push({ role: 'user', text });
      } else if (toolResult) {
        session.tail.push({ role: 'tool', text: '[tool result returned]' });
      }
      if (toolResult) session.pendingToolUse = null;
      session.messageCount += 1;
    } else {
      const text = textFromContent(message.content);
      const toolUses = toolUsesFromContent(message.content);
      session.lastEntry = { role: 'assistant', ts: when, toolUses: toolUses.length > 0 };
      if (toolUses.length > 0) {
        session.pendingToolUse = toolUses[toolUses.length - 1];
        for (const use of toolUses) {
          session.tail.push({ role: 'assistant', text: `[requested tool ${use.name}: ${use.input}]` });
        }
      }
      if (text) {
        session.lastAssistant = { text, ts: when, uuid: entry.uuid || null };
        session.tail.push({ role: 'assistant', text });
      }
      session.messageCount += 1;
    }
  }

  const cleanedFirstUser = firstUserText ? stripMarkup(firstUserText) : null;
  session.title =
    lastSummary ||
    (cleanedFirstUser ? truncate(cleanedFirstUser, 80) : null) ||
    (session.cwd ? path.basename(session.cwd) : null) ||
    'Claude Code session';

  // Keep a bounded conversation tail for the suggestion model.
  session.tail = session.tail.slice(-12).map((turn) => ({
    role: turn.role,
    text: truncate(turn.text, 1500),
  }));

  return session;
}

function truncate(text, max) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

// First user messages sometimes carry injected wrappers (<command-name>,
// <task-notification>, system reminders); drop tag-like spans so titles stay
// readable. Returns null when nothing readable remains.
function stripMarkup(text) {
  const stripped = text
    // tag pairs wrapping a single bare token (ids, slugs) go entirely…
    .replace(/<(\w[\w.-]*)>\s*[^<>\s]*\s*<\/\1>/g, ' ')
    // …other tags are dropped but their prose content is kept
    .replace(/<[^<>]{1,60}>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || null;
}

async function parseFile(filePath) {
  const stat = await fs.promises.stat(filePath);
  const start = Math.max(0, stat.size - TRANSCRIPT_TAIL_BYTES);
  const stream = fs.createReadStream(filePath, { start, encoding: 'utf8' });
  let raw = '';
  for await (const chunk of stream) raw += chunk;
  // If we started mid-file, the first line is probably cut in half; drop it.
  if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1);

  const session = reduceEntries(parseLines(raw), filePath);
  session.mtimeMs = stat.mtimeMs;
  if (!session.sessionId) {
    session.sessionId = path.basename(filePath, '.jsonl');
  }
  return session;
}

module.exports = { parseFile, parseLines, reduceEntries, textFromContent, truncate, stripMarkup };
