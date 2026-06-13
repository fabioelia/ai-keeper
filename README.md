# AI Keeper

A desktop notification panel for [Claude Code](https://code.claude.com). It watches your Claude
Code sessions, tells you which ones are working and which ones are **waiting on you**, and uses a
local Gemma model (via [Ollama](https://ollama.com)) to summarize what the agent said and suggest
quick replies you can send back — without hunting through terminal tabs.

A card in the panel looks like this:

> **infra-tools** · 2m ago
> **AWS SSO login credentials task** — Waiting for next steps.
> *The agent finished wiring AWS SSO config and is asking which profile to log in with before
> running `aws sso login`.*
> Should we… `[Use the existing staging-admin profile]` `[Create a new production profile]`
> `Or type your own reply…` **Send** / **Copy**

Everything runs locally: transcripts are read from disk and summarization happens on your machine
through Ollama. Nothing leaves your computer.

## How it works

```
┌─────────────────────────── AI Keeper (Electron) ───────────────────────────┐
│                                                                            │
│  SessionMonitor ── watches ~/.claude/projects/**/*.jsonl transcripts       │
│        │           (fs.watch + periodic rescan, no native deps)            │
│        │                                                                   │
│  HookServer ────── http://127.0.0.1:43117/event ◀── local Claude Code      │
│        │           hooks (Notification / Stop / UserPromptSubmit)          │
│        │                                                                   │
│  RelayClient ───── subscribes to https://ntfy.sh/<topic> ◀── HTTP hooks    │
│        │           firing inside claude.ai/code web containers             │
│        ▼                                                                   │
│  status.js ─────── working │ needs_input (reply / permission) │ idle       │
│        │                                                                   │
│  gemma.js ───────► Ollama /api/chat (gemma3:4b, JSON-schema output)        │
│        │           → 1–2 sentence summary + two suggested replies          │
│        ▼                                                                   │
│  Notification panel ── option chips, custom reply box                      │
│        │                                                                   │
│  responder.js ───► claude -p "<reply>" --resume <session-id>               │
│                    (or copy to clipboard to paste into the live session)   │
└────────────────────────────────────────────────────────────────────────────┘
```

- **Session discovery** reads the JSONL transcripts Claude Code writes under
  `~/.claude/projects/`. A transcript with fresh writes means the agent is working; one that ends
  on an assistant turn and has gone quiet means it is waiting for you; an unanswered `tool_use`
  reads as a pending permission prompt.
- **Hooks (optional, recommended)** make detection instant and exact instead of heuristic.
  AI Keeper registers `Notification`, `Stop`, and `UserPromptSubmit` hooks in
  `~/.claude/settings.json` that POST the hook payload to a local HTTP endpoint. Install them from
  the in-app settings panel (a backup of your settings file is written first, and only
  ai-keeper-marked entries are ever touched).
- **Gemma suggestions** send the conversation tail to Ollama with a JSON-schema-constrained
  response format, yielding a short summary ("The agent …") plus exactly two candidate replies.
  If Ollama is down or the model is missing, the panel falls back to showing the agent's own last
  message with generic options, so it keeps working.
- **Replying** offers two modes:
  - **Send** runs `claude -p "<reply>" --resume <session-id>` headlessly in the project directory.
    The conversation continues from where it left off (as a new session id — that is how
    `--resume` works). The panel tracks the continuation automatically.
  - **Copy** puts the reply on the clipboard so you can paste it into the still-open interactive
    session — the right choice when the original terminal is in front of you.

## Setup

Requirements: Node 20+, the `claude` CLI, and (for suggestions) Ollama with a Gemma model.

```bash
npm install

# local Gemma for summaries + suggestions
ollama pull gemma3:4b   # or gemma3:12b / gemma3:27b if you have the headroom

npm start
```

Then open settings (⚙) and click **Install hooks** so Claude Code pushes "needs attention"
events to the panel in real time. Without hooks, AI Keeper still works via file watching with a
short delay.

### Demo mode

To see the panel without any real Claude Code sessions:

```bash
npm run demo        # or: AI_KEEPER_DEMO=1 npm start
```

This seeds three sample sessions (one waiting on a decision, one working, one blocked on a
permission prompt). Suggestions still go through Gemma when Ollama is running.

### Claude Code web sessions (claude.ai/code)

Web sessions run in cloud containers, so their transcripts never touch your disk and command
hooks can't run there. AI Keeper supports them through **HTTP hooks + a relay**:

1. Pick a relay. The zero-infra option is an [ntfy.sh](https://ntfy.sh) topic with a long random
   name, e.g. `https://ntfy.sh/ai-keeper-7f3a91c2b4`. Self-hosted ntfy (or any endpoint that
   streams newline-delimited JSON) works too.
2. In AI Keeper's settings, set **Relay URL** (and a token if your relay needs auth), save, and
   click **Copy web hook config**.
3. Merge the copied JSON into the repo's `.claude/settings.json` and commit it. It registers
   `Notification`/`Stop`/`UserPromptSubmit` HTTP hooks pointing at your relay, plus the required
   `allowedHttpHookUrls` allowlist.
4. In the claude.ai/code environment settings, allow the relay domain in the network policy
   (Custom allowlist, or Full access).

Web sessions then show up as `web`-tagged cards the moment they need you. Because there is no
local transcript, those cards don't get Gemma suggestions or a reply box; instead they offer
**Open claude.ai/code** and **Copy teleport** (`claude --teleport <session-id>`), which pulls the
session into your terminal — after which it becomes a regular local session with the full
feature set.

Privacy note: hook payloads (session ids, repo paths, notification text — not conversation
content) transit the relay. Use a private/self-hosted relay or a long random topic, and a token
if you want auth; the generated snippet references the token via `$AI_KEEPER_RELAY_TOKEN` rather
than embedding it.

### Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Ollama URL | `http://127.0.0.1:11434` | Where the Ollama server listens |
| Gemma model | `gemma3:4b` | Any Gemma tag pulled into Ollama |
| Claude CLI path | `claude` | Binary used for `--resume` replies |
| Hook server port | `43117` | Local port the Claude Code hooks POST to |
| Relay URL | (empty) | ntfy-style stream for web session events; empty disables it |
| Relay token | (empty) | Sent as `Authorization: Bearer …` when subscribing |
| Auto-suggest | on | Generate suggestions as soon as a session needs attention |
| Desktop notifications | on | OS notification when a session starts waiting on you |

Settings live in Electron's `userData` directory; nothing is stored in your repos.

## Development

```bash
npm test    # pure-Node unit tests (no Electron needed)
```

The runtime has zero npm dependencies; Electron is the only dev dependency. Main-process modules
(`src/main/*.js`) are plain CommonJS with no Electron imports except `index.js`, which is what
makes the logic unit-testable.

| Path | Role |
| --- | --- |
| `src/main/sessionMonitor.js` | Transcript discovery, watching, session list |
| `src/main/transcript.js` | JSONL parsing → session shape (title, tail, last turns) |
| `src/main/status.js` | working / needs_input / idle classification |
| `src/main/hookServer.js` + `hookInstaller.js` | Claude Code hook intake + settings.json management |
| `src/main/gemma.js` | Ollama client, prompt, JSON parsing, fallbacks |
| `src/main/responder.js` | `claude --resume` headless replies |
| `src/renderer/` | The panel UI (vanilla DOM, no framework) |

## Troubleshooting

**The panel is empty (or only demo data shows).** The demo banner at the top means you launched
with `npm run demo` — use `npm start` for real sessions. In real mode, the empty state and the
settings panel show exactly what is being watched, e.g.
`Watching /Users/you/.claude/projects — 0 transcripts`. If the directory doesn't exist, Claude
Code hasn't run on this machine yet: local terminal/IDE sessions appear automatically once you
start one, while claude.ai/code sessions live in the cloud and need the relay setup above. A
non-standard config location can be pointed at with the `CLAUDE_CONFIG_DIR` environment variable.

**No suggestions / "fallback" tag on summaries.** Ollama isn't reachable or the model isn't
pulled — the settings panel shows which, and `ollama pull gemma3:4b` fixes the latter.

## Known limitations

- Sending a reply uses `claude --resume`, which forks the conversation into a new headless
  session; an interactive terminal still showing the old session won't display it. Use **Copy**
  when you intend to answer inside that terminal.
- Permission prompts are approved in Claude Code itself (or via your permission settings) — the
  panel surfaces them and lets you respond with guidance, but it does not click "allow" for you.
- Without hooks, state detection is heuristic: a session is considered waiting once its
  transcript ends on an assistant turn and has been quiet for ~12 seconds.
