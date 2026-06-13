'use strict';

// Local Gemma client, spoken over the Ollama HTTP API. Given the tail of a
// Claude Code conversation it produces:
//   summary  - 1-2 plain-language sentences describing what the agent just
//              said or is asking for
//   options  - two short replies the human could send back
// Output shape is enforced with Ollama's JSON-schema `format` option, which
// Gemma models support via grammar-constrained decoding.

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    options: {
      type: 'array',
      items: { type: 'string' },
      minItems: 2,
      maxItems: 2,
    },
  },
  required: ['summary', 'options'],
};

const SYSTEM_PROMPT = [
  'You monitor conversations between a human and the Claude Code coding agent.',
  'Given the latest exchange, return JSON with:',
  '- "summary": 1-2 sentences, plain language, describing what the agent just did and what it is waiting on. Start with "The agent".',
  '- "options": exactly two short, distinct replies the human could send next. Each under 12 words, written as the human (e.g. "Yes, run the migration" or "Show me the diff first").',
  'Base everything only on the conversation. Never invent file names, commands, or facts.',
].join('\n');

function buildMessages(session) {
  const lines = [];
  lines.push(`Project: ${session.cwd || 'unknown'}`);
  lines.push(`Task: ${session.title || 'unknown'}`);
  if (session.statusContext) lines.push(`Status: ${session.statusContext}`);
  lines.push('');
  lines.push('Conversation (most recent last):');
  for (const turn of session.tail || []) {
    const speaker = turn.role === 'assistant' ? 'AGENT' : turn.role === 'tool' ? 'TOOL' : 'HUMAN';
    lines.push(`${speaker}: ${turn.text}`);
  }
  lines.push('');
  lines.push('Summarize what the agent is waiting on and suggest two replies the human could send.');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ];
}

async function suggest(session, { ollamaUrl, model, timeoutMs = 60_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${stripSlash(ollamaUrl)}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        format: RESPONSE_SCHEMA,
        options: { temperature: 0.4 },
        messages: buildMessages(session),
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = await res.json();
    const parsed = parseResponse(data && data.message && data.message.content);
    if (!parsed) throw new Error('Gemma returned malformed JSON');
    return { ...parsed, source: 'gemma' };
  } finally {
    clearTimeout(timer);
  }
}

function parseResponse(content) {
  if (typeof content !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Some models wrap JSON in code fences despite the format constraint.
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed.summary !== 'string') return null;
  const options = Array.isArray(parsed.options)
    ? parsed.options.filter((o) => typeof o === 'string' && o.trim()).slice(0, 2)
    : [];
  if (options.length === 0) return null;
  return { summary: parsed.summary.trim(), options: options.map((o) => o.trim()) };
}

// Used when Ollama is unreachable or the model misbehaves, so the panel keeps
// functioning with sensible generic choices.
function fallbackSuggestion(session) {
  if (session.fallback) return { ...session.fallback, source: 'fallback' };
  const lastText = session.lastAssistant ? session.lastAssistant.text : '';
  const summary = lastText
    ? `The agent replied with: ${firstSentences(lastText, 2, 240)}`
    : 'The agent is waiting for your input.';
  const options =
    session.pendingToolUse != null
      ? ['Approve it and continue', 'Explain what that will do first']
      : ['Yes, go ahead', 'Walk me through the options first'];
  return { summary, options, source: 'fallback' };
}

function firstSentences(text, count, maxLen) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const sentences = clean.match(/[^.!?]+[.!?]+/g);
  const out = sentences ? sentences.slice(0, count).join(' ').trim() : clean;
  return out.length > maxLen ? `${out.slice(0, maxLen - 1)}…` : out;
}

async function ping({ ollamaUrl, model, timeoutMs = 5_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${stripSlash(ollamaUrl)}/api/tags`, { signal: controller.signal });
    if (!res.ok) return { reachable: false, hasModel: false };
    const data = await res.json();
    const models = Array.isArray(data.models) ? data.models.map((m) => m.name || '') : [];
    const wanted = String(model || '');
    const hasModel = models.some((name) => name === wanted || name.split(':')[0] === wanted.split(':')[0]);
    return { reachable: true, hasModel, models };
  } catch {
    return { reachable: false, hasModel: false };
  } finally {
    clearTimeout(timer);
  }
}

function stripSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

module.exports = { suggest, ping, fallbackSuggestion, buildMessages, parseResponse, RESPONSE_SCHEMA };
