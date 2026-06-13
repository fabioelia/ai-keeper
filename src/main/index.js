'use strict';

const path = require('path');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  ipcMain,
  clipboard,
  shell,
  nativeImage,
} = require('electron');

const { Store } = require('./store');
const { SessionMonitor, sortItems } = require('./sessionMonitor');
const { DemoMonitor } = require('./demo');
const { HookServer } = require('./hookServer');
const hookInstaller = require('./hookInstaller');
const gemma = require('./gemma');
const { sendToClaude } = require('./responder');
const { trayIconPng } = require('./trayIcon');
const { RelayClient, RemoteSessions } = require('./relay');

const DEMO = process.env.AI_KEEPER_DEMO === '1';

let win = null;
let tray = null;
let store = null;
let monitor = null;
let hookServer = null;
let relay = null;
let relayConnected = false;
let quitting = false;

const remoteSessions = new RemoteSessions();

const suggestionCache = new Map(); // cache key -> suggestion payload
const suggestionInFlight = new Map(); // cache key -> promise
const notifiedKeys = new Set();
// Sessions already waiting when the app starts shouldn't blast a stack of
// notifications; only transitions that happen while we're running do.
let seededExisting = false;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 460,
    height: 760,
    minWidth: 380,
    minHeight: 520,
    title: 'AI Keeper',
    backgroundColor: '#0f1115',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // Headless verification aid: AI_KEEPER_SCREENSHOT=/path.png captures the
  // panel a few seconds after load and exits. Used by CI/dev containers.
  if (process.env.AI_KEEPER_SCREENSHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const image = await win.webContents.capturePage();
          require('fs').writeFileSync(process.env.AI_KEEPER_SCREENSHOT, image.toPNG());
        } finally {
          quitting = true;
          app.quit();
        }
      }, 6_000);
    });
  }
  win.on('close', (event) => {
    // Keep running in the tray; Quit lives in the tray menu.
    if (!quitting && tray) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    win = null;
  });
}

function createTray(attentionCount) {
  try {
    const icon = nativeImage.createFromBuffer(trayIconPng({ attention: attentionCount > 0 }));
    tray = new Tray(icon);
    tray.setToolTip('AI Keeper');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show panel', click: () => showWindow() },
        { type: 'separator' },
        { label: 'Quit AI Keeper', click: () => app.quit() },
      ]),
    );
    tray.on('click', () => showWindow());
  } catch {
    tray = null; // some Linux environments have no tray support
  }
}

function showWindow() {
  if (!win) createWindow();
  else {
    win.show();
    win.focus();
  }
}

function updateTray(items) {
  if (!tray) return;
  const count = items.filter((i) => i.needsAttention).length;
  try {
    tray.setImage(nativeImage.createFromBuffer(trayIconPng({ attention: count > 0 })));
    tray.setToolTip(count > 0 ? `AI Keeper — ${count} session(s) need attention` : 'AI Keeper — all quiet');
  } catch {
    // ignore tray failures
  }
}

function suggestionKey(session) {
  const turn = session.lastAssistant ? session.lastAssistant.uuid || session.lastAssistant.ts : session.mtimeMs;
  return `${session.sessionId}:${turn}`;
}

function statusContextFor(item) {
  if (!item) return null;
  if (item.reason === 'permission') return item.statusMessage;
  if (item.reason === 'reply') return 'The agent finished its turn and is waiting for the next instruction.';
  return null;
}

async function getSuggestion(sessionId) {
  const session = monitor.getSession(sessionId);
  if (!session) return null;
  const key = suggestionKey(session);
  if (suggestionCache.has(key)) return suggestionCache.get(key);
  if (suggestionInFlight.has(key)) return suggestionInFlight.get(key);

  const item = monitor.list().find((i) => i.sessionId === sessionId) || null;
  const settings = store.get();
  const promise = (async () => {
    let result;
    try {
      result = await gemma.suggest(
        { ...session, statusContext: statusContextFor(item) },
        { ollamaUrl: settings.ollamaUrl, model: settings.model },
      );
    } catch {
      result = gemma.fallbackSuggestion(session);
    }
    const payload = { sessionId, key, ...result };
    suggestionCache.set(key, payload);
    if (suggestionCache.size > 200) {
      suggestionCache.delete(suggestionCache.keys().next().value);
    }
    send('suggestion:ready', payload);
    return payload;
  })().finally(() => suggestionInFlight.delete(key));

  suggestionInFlight.set(key, promise);
  return promise;
}

function allItems() {
  return sortItems([...monitor.list(), ...remoteSessions.items()]);
}

function pushSessions() {
  const items = allItems();
  send('sessions:updated', { sessions: items, stats: monitor.getStats() });
  handleAttention(items);
  updateTray(items);
}

function handleAttention(items) {
  const settings = store.get();
  const firstScan = !seededExisting;
  seededExisting = true;
  for (const item of items) {
    if (!item.needsAttention) continue;
    const key = `${item.sessionId}:${item.lastAssistantUuid || item.lastActivity}:${item.reason}`;
    if (notifiedKeys.has(key)) continue;
    notifiedKeys.add(key);
    if (notifiedKeys.size > 500) notifiedKeys.delete(notifiedKeys.values().next().value);

    if (firstScan) {
      if (settings.autoSuggest && !item.remote) getSuggestion(item.sessionId).catch(() => {});
      continue;
    }
    if (settings.notifications && Notification.isSupported()) {
      const notification = new Notification({
        title: `${item.project}: ${item.title}`,
        body: item.statusMessage + (item.lastAssistantText ? `\n${item.lastAssistantText}` : ''),
        silent: false,
      });
      notification.on('click', () => showWindow());
      notification.show();
    }
    if (settings.autoSuggest && !item.remote) {
      getSuggestion(item.sessionId).catch(() => {});
    }
  }
}

function startRelay() {
  if (relay) relay.stop();
  relay = null;
  relayConnected = false;
  const { relayUrl, relayToken } = store.get();
  if (!relayUrl) {
    send('relay:status', { configured: false, connected: false });
    return;
  }
  relay = new RelayClient({ url: relayUrl, token: relayToken });
  relay.on('event', (event) => {
    remoteSessions.apply(event);
    pushSessions();
  });
  relay.on('status', ({ connected }) => {
    relayConnected = connected;
    send('relay:status', { configured: true, connected });
  });
  relay.start();
  send('relay:status', { configured: true, connected: false });
}

async function startHookServer() {
  if (hookServer) hookServer.stop();
  hookServer = new HookServer({ port: store.get().hookPort });
  hookServer.on('event', (event) => monitor.applyHookEvent(event));
  hookServer.on('error', () => {});
  const ok = await hookServer.start();
  if (!ok) hookServer = null;
}

async function pushGemmaStatus() {
  const settings = store.get();
  const status = await gemma.ping({ ollamaUrl: settings.ollamaUrl, model: settings.model });
  send('gemma:status', { ...status, model: settings.model, ollamaUrl: settings.ollamaUrl });
}

function registerIpc() {
  ipcMain.handle('sessions:get', () => ({ sessions: allItems(), stats: monitor.getStats() }));

  ipcMain.handle('session:suggest', (_event, sessionId) => getSuggestion(sessionId));

  ipcMain.handle('session:open', (_event, sessionId) => {
    const session = monitor.getSession(sessionId);
    if (session && session.cwd) shell.openPath(session.cwd);
    return true;
  });

  ipcMain.handle('web:open', () => {
    shell.openExternal('https://claude.ai/code');
    return true;
  });

  ipcMain.handle('clipboard:write', (_event, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });

  ipcMain.handle('relay:status', () => ({
    configured: Boolean(store.get().relayUrl),
    connected: relayConnected,
  }));

  ipcMain.handle('relay:snippet', () => {
    const settings = store.get();
    if (!settings.relayUrl) return null;
    return JSON.stringify(
      hookInstaller.webHookSnippet({ relayUrl: settings.relayUrl, relayToken: settings.relayToken }),
      null,
      2,
    );
  });

  ipcMain.handle('session:respond', async (_event, { sessionId, text, mode }) => {
    const session = monitor.getSession(sessionId);
    if (!session || !text || !String(text).trim()) {
      return { ok: false, error: 'Nothing to send.' };
    }
    const reply = String(text).trim();

    if (mode === 'clipboard') {
      clipboard.writeText(reply);
      return { ok: true, mode: 'clipboard' };
    }

    send('respond:update', { sessionId, state: 'running' });
    const run = DEMO
      ? new Promise((resolve) =>
          setTimeout(() => resolve({ ok: true, output: '(demo) Claude acknowledged your reply.' }), 1500),
        )
      : sendToClaude({
          sessionId,
          cwd: session.cwd,
          text: reply,
          claudePath: store.get().claudePath,
        });

    run
      .then((result) => {
        if (result.ok) {
          monitor.applyHookEvent({ sessionId, kind: 'responded', ts: Date.now() });
          send('respond:update', {
            sessionId,
            state: 'done',
            output: (result.output || '').slice(0, 1200),
          });
        } else {
          send('respond:update', { sessionId, state: 'error', error: result.error });
        }
      })
      .catch((err) => send('respond:update', { sessionId, state: 'error', error: String(err && err.message) }));

    return { ok: true, mode: 'resume', started: true };
  });

  ipcMain.handle('settings:get', () => ({ ...store.get(), demo: DEMO }));

  ipcMain.handle('settings:set', async (_event, patch) => {
    const before = store.get();
    const after = store.set(patch || {});
    if (after.hookPort !== before.hookPort) await startHookServer();
    if (after.ollamaUrl !== before.ollamaUrl || after.model !== before.model) {
      suggestionCache.clear();
      pushGemmaStatus().catch(() => {});
    }
    if (after.relayUrl !== before.relayUrl || after.relayToken !== before.relayToken) {
      startRelay();
    }
    return { ...after, demo: DEMO };
  });

  ipcMain.handle('hooks:install', () => hookInstaller.install({ port: store.get().hookPort }));
  ipcMain.handle('hooks:uninstall', () => hookInstaller.uninstall());
  ipcMain.handle('hooks:status', () => hookInstaller.statusOf());

  ipcMain.handle('gemma:status', async () => {
    const settings = store.get();
    const status = await gemma.ping({ ollamaUrl: settings.ollamaUrl, model: settings.model });
    return { ...status, model: settings.model, ollamaUrl: settings.ollamaUrl };
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(async () => {
    app.setName('AI Keeper');
    store = new Store(app.getPath('userData'));
    monitor = DEMO ? new DemoMonitor() : new SessionMonitor();

    monitor.on('update', () => pushSessions());

    registerIpc();
    createTray(0);
    createWindow();
    await startHookServer();
    startRelay();
    await monitor.start();

    pushGemmaStatus().catch(() => {});
    const gemmaTimer = setInterval(() => pushGemmaStatus().catch(() => {}), 60_000);
    if (gemmaTimer.unref) gemmaTimer.unref();

    app.on('activate', () => showWindow());
  });

  app.on('before-quit', () => {
    quitting = true;
    if (monitor) monitor.stop();
    if (hookServer) hookServer.stop();
    if (relay) relay.stop();
  });

  app.on('window-all-closed', () => {
    // Tray keeps the app alive; without a tray, closing the window quits.
    if (!tray) app.quit();
  });
}
