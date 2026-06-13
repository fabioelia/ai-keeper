'use strict';

const { spawn } = require('child_process');

const OUTPUT_CAP = 20_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// Sends a follow-up to a Claude Code session by resuming it headlessly:
//   claude -p "<text>" --resume <sessionId>
// This continues the conversation from where it left off. If the original
// session is still open in an interactive terminal, the resumed run is a
// continuation the terminal won't show, which is why the UI also offers
// copy-to-clipboard for pasting into the live session instead.
function sendToClaude({ sessionId, cwd, text, claudePath = 'claude', timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(claudePath, ['-p', text, '--resume', sessionId], {
        cwd: cwd || process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (err) {
      resolve({ ok: false, error: String(err && err.message) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill('SIGTERM');
        finish({ ok: false, error: `claude timed out after ${Math.round(timeoutMs / 1000)}s`, output: stdout });
      }
    }, timeoutMs);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on('data', (chunk) => {
      if (stdout.length < OUTPUT_CAP) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < OUTPUT_CAP) stderr += chunk;
    });
    child.on('error', (err) => {
      finish({ ok: false, error: `Could not run "${claudePath}": ${err.message}` });
    });
    child.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true, output: stdout.trim() });
      } else {
        finish({ ok: false, error: (stderr || stdout || `claude exited with code ${code}`).trim().slice(0, 2000) });
      }
    });
  });
}

module.exports = { sendToClaude };
