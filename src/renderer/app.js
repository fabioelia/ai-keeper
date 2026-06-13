'use strict';

const api = window.aiKeeper;

const state = {
  sessions: [],
  suggestions: new Map(), // sessionId -> { key, summary, options, source }
  requested: new Set(), // suggestion keys already asked for
  drafts: new Map(), // sessionId -> reply draft
  respond: new Map(), // sessionId -> { state, output?, error? }
  settings: null,
  gemma: null,
  hooks: null,
  lastSignature: '',
};

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child != null) node.append(child);
  }
  return node;
}

function timeAgo(ts) {
  if (!ts) return '';
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

let toastTimer = null;
function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add('hidden'), 2600);
}

/* ---------- session cards ---------- */

function suggestionFor(item) {
  const suggestion = state.suggestions.get(item.sessionId);
  if (!suggestion) return null;
  // A suggestion is only valid for the assistant turn it was generated from.
  const turnKey = `${item.sessionId}:${item.lastAssistantUuid || ''}`;
  return suggestion.turnKey === turnKey ? suggestion : null;
}

function requestSuggestion(item) {
  const turnKey = `${item.sessionId}:${item.lastAssistantUuid || ''}`;
  if (state.requested.has(turnKey)) return;
  state.requested.add(turnKey);
  api
    .suggest(item.sessionId)
    .then((payload) => {
      if (payload) storeSuggestion(payload);
    })
    .catch(() => {});
}

function storeSuggestion(payload) {
  const item = state.sessions.find((s) => s.sessionId === payload.sessionId);
  const turnKey = `${payload.sessionId}:${item ? item.lastAssistantUuid || '' : ''}`;
  state.suggestions.set(payload.sessionId, { ...payload, turnKey });
  render();
}

function attentionCard(item) {
  const suggestion = suggestionFor(item);
  const respond = state.respond.get(item.sessionId);
  const busy = respond && respond.state === 'running';

  const card = el('div', { class: 'card attention' });
  card.append(
    el(
      'div',
      { class: 'card-top' },
      el('span', { class: 'chip', text: item.project, title: item.cwd || '' }),
      el('span', { class: 'time', text: timeAgo(item.lastActivity) }),
    ),
    el('div', { class: 'card-title', text: item.title }),
    el('div', { class: 'card-status', text: item.statusMessage }),
  );

  if (suggestion) {
    const reply = el('div', { class: 'agent-reply', text: suggestion.summary });
    reply.append(el('span', { class: 'src', text: suggestion.source === 'gemma' ? 'via gemma' : 'fallback' }));
    card.append(reply);
  } else if (item.lastAssistantText) {
    card.append(el('div', { class: 'agent-reply', text: `The agent replied: “${item.lastAssistantText}”` }));
    card.append(el('div', { class: 'agent-reply pending', text: 'Summarizing with Gemma…' }));
  } else {
    card.append(el('div', { class: 'agent-reply pending', text: 'Generating summary…' }));
  }

  const textarea = el('textarea', {
    rows: '1',
    placeholder: 'Or type your own reply…',
    oninput: (event) => state.drafts.set(item.sessionId, event.target.value),
  });
  textarea.value = state.drafts.get(item.sessionId) || '';

  if (suggestion && suggestion.options.length > 0) {
    card.append(el('div', { class: 'should-we', text: 'Should we…' }));
    const options = el('div', { class: 'options' });
    for (const option of suggestion.options) {
      options.append(
        el('button', {
          class: 'option-btn',
          text: option,
          onclick: () => {
            state.drafts.set(item.sessionId, option);
            textarea.value = option;
            textarea.focus();
          },
        }),
      );
    }
    card.append(options);
  }

  const sendBtn = el('button', {
    class: 'primary',
    text: busy ? 'Sending…' : 'Send',
    title: 'Resume this session headlessly: claude -p "…" --resume <session>',
    onclick: () => sendReply(item, textarea.value, 'resume'),
  });
  if (busy) sendBtn.disabled = true;

  card.append(
    el(
      'div',
      { class: 'reply-row' },
      textarea,
      sendBtn,
      el('button', {
        class: 'ghost',
        text: 'Copy',
        title: 'Copy the reply to paste into the live Claude Code session',
        onclick: () => sendReply(item, textarea.value, 'clipboard'),
      }),
    ),
  );

  if (respond && respond.state !== 'running') {
    const line =
      respond.state === 'done'
        ? `Sent. Claude: ${respond.output || '(no output)'}`
        : `Send failed: ${respond.error || 'unknown error'}`;
    card.append(el('div', { class: `respond-state ${respond.state}`, text: line.slice(0, 300) }));
  }

  card.append(
    el(
      'div',
      { class: 'card-foot' },
      el('button', { class: 'link', text: 'Open project', onclick: () => api.openProject(item.sessionId) }),
      el('span', { text: `session ${String(item.sessionId).slice(0, 8)}` }),
    ),
  );
  return card;
}

function workingCard(item) {
  const status = el('div', { class: 'card-status' }, el('span', { class: 'pulse' }), document.createTextNode(item.statusMessage));
  return el(
    'div',
    { class: 'card working' },
    el(
      'div',
      { class: 'card-top' },
      el('span', { class: 'chip', text: item.project, title: item.cwd || '' }),
      el('span', { class: 'time', text: timeAgo(item.lastActivity) }),
    ),
    el('div', { class: 'card-title', text: item.title }),
    status,
  );
}

function idleCard(item) {
  return el(
    'div',
    { class: 'card idle' },
    el(
      'div',
      { class: 'card-top' },
      el('span', { class: 'chip', text: item.project, title: item.cwd || '' }),
      el('span', { class: 'card-title', text: item.title }),
      el('span', { class: 'time', text: timeAgo(item.lastActivity) }),
    ),
  );
}

function sendReply(item, text, mode) {
  const reply = (text || '').trim();
  if (!reply) {
    toast('Type or pick a reply first.');
    return;
  }
  api
    .respond({ sessionId: item.sessionId, text: reply, mode })
    .then((result) => {
      if (mode === 'clipboard' && result.ok) {
        toast('Copied — paste it into the running Claude Code session.');
      } else if (result.ok) {
        state.respond.set(item.sessionId, { state: 'running' });
        state.drafts.delete(item.sessionId);
        render(true);
      } else {
        toast(result.error || 'Could not send.');
      }
    })
    .catch(() => toast('Could not send.'));
}

/* ---------- rendering ---------- */

function signature() {
  return JSON.stringify([
    state.sessions,
    [...state.suggestions.entries()],
    [...state.respond.entries()],
  ]);
}

function render(force = false) {
  const sig = signature();
  if (!force && sig === state.lastSignature) return;
  state.lastSignature = sig;

  const root = $('sessions');
  root.replaceChildren();

  const attention = state.sessions.filter((s) => s.state === 'needs_input');
  const working = state.sessions.filter((s) => s.state === 'working');
  const idle = state.sessions.filter((s) => s.state === 'idle');

  const badge = $('attention-badge');
  badge.textContent = String(attention.length);
  badge.classList.toggle('hidden', attention.length === 0);

  if (state.sessions.length === 0) {
    root.append(
      el(
        'div',
        { class: 'empty' },
        el('p', { text: 'No Claude Code sessions found.' }),
        el('p', {}, document.createTextNode('Start one in a terminal, or try the sample data with '), el('code', { text: 'npm run demo' }), document.createTextNode('.')),
      ),
    );
    return;
  }

  if (attention.length > 0) {
    root.append(el('div', { class: 'section-label', text: 'Needs your attention' }));
    for (const item of attention) {
      requestSuggestion(item);
      root.append(attentionCard(item));
    }
  }
  if (working.length > 0) {
    root.append(el('div', { class: 'section-label', text: 'Working' }));
    for (const item of working) root.append(workingCard(item));
  }
  if (idle.length > 0) {
    root.append(el('div', { class: 'section-label', text: `Recent (${idle.length})` }));
    for (const item of idle) root.append(idleCard(item));
  }
}

/* ---------- settings ---------- */

function fillSettingsForm() {
  const s = state.settings;
  if (!s) return;
  $('set-ollama').value = s.ollamaUrl;
  $('set-model').value = s.model;
  $('set-claude').value = s.claudePath;
  $('set-port').value = s.hookPort;
  $('set-autosuggest').checked = Boolean(s.autoSuggest);
  $('set-notify').checked = Boolean(s.notifications);
}

async function saveSettings() {
  const patch = {
    ollamaUrl: $('set-ollama').value.trim(),
    model: $('set-model').value.trim(),
    claudePath: $('set-claude').value.trim() || 'claude',
    hookPort: Number($('set-port').value) || 43117,
    autoSuggest: $('set-autosuggest').checked,
    notifications: $('set-notify').checked,
  };
  state.settings = await api.setSettings(patch);
  state.requested.clear();
  toast('Settings saved.');
  refreshGemmaStatus();
}

function renderGemmaStatus() {
  const dot = $('gemma-dot');
  const text = $('gemma-state');
  const g = state.gemma;
  dot.className = 'status-dot';
  if (!g) {
    text.textContent = 'Checking…';
    return;
  }
  if (!g.reachable) {
    dot.classList.add('bad');
    dot.title = 'Ollama unreachable';
    text.textContent = `Ollama is unreachable at ${g.ollamaUrl}. Start it with \`ollama serve\`; suggestions fall back to canned replies meanwhile.`;
  } else if (!g.hasModel) {
    dot.classList.add('warn');
    dot.title = `Model ${g.model} not pulled`;
    text.textContent = `Ollama is running but ${g.model} is missing. Run \`ollama pull ${g.model}\`.`;
  } else {
    dot.classList.add('ok');
    dot.title = `Gemma ready (${g.model})`;
    text.textContent = `Gemma ready: ${g.model} via ${g.ollamaUrl}.`;
  }
}

function renderHooksStatus() {
  const dot = $('hooks-dot');
  const label = $('hooks-state');
  dot.className = 'status-dot';
  if (!state.hooks) {
    label.textContent = '';
    return;
  }
  if (state.hooks.installed) {
    dot.classList.add('ok');
    dot.title = 'Claude Code hooks installed';
    label.textContent = 'Installed ✓';
  } else {
    dot.classList.add('warn');
    dot.title = 'Hooks not installed — using file watching only';
    label.textContent = 'Not installed (file watching only)';
  }
}

async function refreshGemmaStatus() {
  state.gemma = await api.gemmaStatus();
  renderGemmaStatus();
}

async function refreshHooksStatus() {
  state.hooks = await api.hooksStatus();
  renderHooksStatus();
}

/* ---------- init ---------- */

async function init() {
  state.settings = await api.getSettings();
  fillSettingsForm();

  $('settings-btn').addEventListener('click', () => {
    $('settings-panel').classList.toggle('hidden');
    fillSettingsForm();
    refreshHooksStatus();
  });
  $('close-settings').addEventListener('click', () => $('settings-panel').classList.add('hidden'));
  $('save-settings').addEventListener('click', () => saveSettings().catch(() => toast('Could not save settings.')));
  $('install-hooks').addEventListener('click', async () => {
    try {
      state.hooks = await api.installHooks();
      renderHooksStatus();
      toast('Hooks installed into ~/.claude/settings.json');
    } catch {
      toast('Hook install failed.');
    }
  });

  api.on('sessions:updated', (sessions) => {
    state.sessions = sessions;
    render();
  });
  api.on('suggestion:ready', (payload) => storeSuggestion(payload));
  api.on('respond:update', ({ sessionId, state: respondState, output, error }) => {
    state.respond.set(sessionId, { state: respondState, output, error });
    render(true);
  });
  api.on('gemma:status', (status) => {
    state.gemma = status;
    renderGemmaStatus();
  });

  state.sessions = await api.getSessions();
  render(true);
  refreshGemmaStatus().catch(() => {});
  refreshHooksStatus().catch(() => {});

  // Keep "Xm ago" labels fresh.
  setInterval(() => {
    if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return;
    render(true);
  }, 30_000);
}

init().catch((err) => {
  document.body.append(el('div', { class: 'empty', text: `Failed to start: ${err.message}` }));
});
