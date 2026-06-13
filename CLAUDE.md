# AI Keeper — notes for Claude Code

Electron notification panel for Claude Code sessions with local Gemma (Ollama) suggestions.

## Commands

- `npm test` — pure-Node unit tests (`node --test "test/*.test.js"`), no Electron required.
- `npm start` — launch the app (needs a display).
- `npm run demo` — launch with seeded fake sessions (`AI_KEEPER_DEMO=1`).
- `node --check src/main/<file>.js` — quick syntax gate; there is no bundler or transpiler.

## Architecture rules

- Plain CommonJS everywhere; zero runtime npm dependencies. Do not add a framework or bundler.
- `src/main/index.js` and `src/preload/index.js` are the only files allowed to `require('electron')`.
  Everything else under `src/main/` must stay Electron-free so the unit tests keep running.
- Renderer is vanilla DOM built through the `el()` helper in `src/renderer/app.js`; always set text
  via `textContent`/`text:` (never innerHTML) — transcript content is untrusted.
- Session state flow: transcripts (`transcript.js`) + hook events (`hookServer.js`) →
  `status.js#computeStatus` → `sessionMonitor.js#toItem` → IPC push `sessions:updated`
  (envelope `{ sessions, stats }`). Remote web sessions arrive via `relay.js` (ntfy-style
  stream of HTTP-hook payloads) and merge into the same list as `remote: true` items.
- Hook entries written into `~/.claude/settings.json` carry the `# ai-keeper` marker; the
  installer/uninstaller must only ever touch entries with that marker.
