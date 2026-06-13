'use strict';

// Risk classification for Claude Code tool/permission requests.
//
// This is the safety spine for any automation AI Keeper layers on top of
// Claude sessions. It is intentionally deterministic and conservative: given a
// pending tool use (what the agent is asking permission to do), it returns one
// of three tiers:
//
//   safe    - read-only / inspection only. Reversible, no side effects.
//             The ONLY tier that may ever be auto-approved.
//   caution - real but bounded side effects (edit a file in the repo, run a
//             build). Always escalates to a human by default; a project may
//             later opt specific patterns into auto via `rules.allow`.
//   danger  - destructive, irreversible, privilege-escalating, or
//             secret-touching. A hard floor: never auto-approvable, regardless
//             of mode or user rules. The model is never allowed to soften this.
//
// Invariant for the automation layer (see automation design notes): a model
// may only move a decision toward *more* caution (safe->caution->danger),
// never toward less. Policy is the floor; the model can only raise it.

const SAFE_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
  'TodoWrite', // updates the agent's own todo list; no external effect
]);

// File-touching tools: bounded side effects, always escalate by default.
const CAUTION_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Update']);

// Network reads: not destructive, but can exfiltrate context or pull untrusted
// content, so they are never silently auto-approved.
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch']);

// Bash command leaders that only read state. Every segment of a piped/chained
// command must be in this set (and the command must have no write redirection)
// for the whole command to count as safe.
const SAFE_BASH = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'find', 'tree',
  'echo', 'printf', 'date', 'whoami', 'hostname', 'uname', 'env', 'printenv',
  'which', 'type', 'grep', 'rg', 'ag', 'sort', 'uniq', 'cut', 'awk', 'sed',
  'diff', 'cmp', 'basename', 'dirname', 'realpath', 'readlink', 'du', 'df',
  'ps', 'top', 'jq', 'yq', 'column', 'nl', 'tac', 'fold', 'tr', 'xxd', 'od',
  'git', // only read-only subcommands, checked below
  'node', 'python', 'python3', 'ruby', // only with read-only flags, checked below
  'npm', 'npx', 'yarn', 'pnpm', 'cargo', 'go', // only with read-only subcommands
]);

// Substrings / patterns that force `danger` no matter where they appear.
const DANGER_PATTERNS = [
  /\brm\s+-[a-z]*[rf]/i, // rm -rf, rm -fr, rm -r
  /\brm\s+-[a-z]*f/i,
  /\brmdir\b/i,
  /\b(sudo|su|doas)\b/i,
  /\bdd\b\s+if=/i,
  /\bmkfs\b/i,
  /\bchmod\s+(-[a-z]*\s+)?(777|a\+rwx|\+s)\b/i,
  /\bchown\s+-R\b/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\b(kill|pkill|killall)\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b/i,
  /\bgit\s+checkout\s+--\s/i,
  /\bnpm\s+publish\b/i,
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|python|node)\b/i, // pipe-to-shell
  /\beval\b/i,
  /:\s*\(\s*\)\s*\{.*\}\s*;/, // fork bomb :(){ :|:& };:
  /\b(mv|cp)\b[^|]*\s\/(etc|usr|bin|boot|dev|sys)\b/i,
  />\s*\/dev\/sd[a-z]/i,
  /\b(shred|truncate)\b/i,
  /\b(docker|kubectl|helm|terraform|pulumi)\b/i, // infra mutation; always review
  /\baws\s+(?!.*\b(describe|list|get|help)\b)/i, // mutating aws calls
  /\bsystemctl\s+(start|stop|restart|disable|enable)\b/i,
  /\b(mkfs|fdisk|parted|wipefs)\b/i,
];

// Sensitive paths: reading or (worse) writing these always escalates.
const SENSITIVE_PATH = /(\.ssh\/|\.aws\/|\.config\/gcloud|\bid_rsa\b|\bid_ed25519\b|\.env(\.|$|\b)|credentials|secrets?\b|\.pem\b|\.netrc\b|\/etc\/(passwd|shadow|sudoers))/i;

// git subcommands that only read.
const SAFE_GIT_SUB = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'remote', 'describe', 'blame',
  'ls-files', 'ls-tree', 'rev-parse', 'config', 'shortlog', 'reflog', 'tag',
  'cat-file', 'whatchanged', 'grep', 'fetch',
]);

// Read-only-ish package subcommands (no install/run of arbitrary scripts).
const SAFE_PKG_SUB = new Set(['test', 'run', 'list', 'ls', 'outdated', 'view', 'audit', 'why']);

function tier(risk, reason, autoApprovable) {
  return { risk, reason, autoApprovable };
}

// Classify a single { name, input } tool use. `input` is the compacted string
// AI Keeper already extracts (command for Bash, file_path for file tools).
function classifyTool(toolUse, rules = {}) {
  if (!toolUse || !toolUse.name) {
    return tier('caution', 'Unrecognized request — review before approving.', false);
  }
  const name = toolUse.name;
  const input = typeof toolUse.input === 'string' ? toolUse.input : '';

  // User-authored deny rules always win, producing danger.
  if (matchesAny(rules.deny, input) || matchesAny(rules.deny, name)) {
    return tier('danger', 'Matches a project deny rule.', false);
  }

  if (name === 'Bash') {
    return classifyBash(input, rules);
  }

  if (SAFE_TOOLS.has(name)) {
    // Reading a secret file is still sensitive even though Read is read-only.
    if (name === 'Read' && SENSITIVE_PATH.test(input)) {
      return tier('caution', 'Reads a sensitive path (credentials/keys).', false);
    }
    return tier('safe', `${name} is read-only.`, true);
  }

  if (CAUTION_TOOLS.has(name)) {
    if (SENSITIVE_PATH.test(input)) {
      return tier('danger', 'Writes to a sensitive path (credentials/keys).', false);
    }
    return tier('caution', `${name} modifies files — review the change.`, false);
  }

  if (NETWORK_TOOLS.has(name)) {
    return tier('caution', `${name} reaches the network — review the target.`, false);
  }

  // Unknown tool (could be an MCP server tool): default to escalation.
  return tier('caution', `${name}: unfamiliar tool, review before approving.`, false);
}

function classifyBash(command, rules = {}) {
  const raw = String(command || '');
  if (!raw.trim()) return tier('caution', 'Empty command — review.', false);

  // Hard floor first: any danger pattern anywhere -> danger.
  for (const pattern of DANGER_PATTERNS) {
    if (pattern.test(raw)) {
      return tier('danger', 'Destructive or privileged command — must be reviewed.', false);
    }
  }
  if (SENSITIVE_PATH.test(raw)) {
    return tier('danger', 'Touches credentials/keys — must be reviewed.', false);
  }

  // User allow rules can promote an otherwise-cautious command to safe, but
  // only because we already cleared the danger floor above.
  if (matchesAny(rules.allow, raw)) {
    return tier('safe', 'Matches a project allow rule.', true);
  }

  // Write redirection means side effects -> not safe.
  if (/(^|[^>0-9])>>?(?!&)/.test(raw)) {
    return tier('caution', 'Writes output to a file — review.', false);
  }

  // Every chained/piped segment must lead with a read-only command.
  const segments = raw.split(/\|\||&&|;|\n|\|/).map((s) => s.trim()).filter(Boolean);
  for (const segment of segments) {
    if (!isReadOnlySegment(segment)) {
      return tier('caution', 'Command may have side effects — review.', false);
    }
  }
  return tier('safe', 'Read-only shell command.', true);
}

function isReadOnlySegment(segment) {
  // Drop leading VAR=value assignments, then take the leader token.
  const tokens = segment.split(/\s+/).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  if (tokens.length === 0) return false;
  const leader = tokens[0].replace(/^.*\//, ''); // strip any path prefix
  if (!SAFE_BASH.has(leader)) return false;

  if (leader === 'git') {
    const sub = tokens[1];
    return Boolean(sub) && SAFE_GIT_SUB.has(sub);
  }
  if (['npm', 'npx', 'yarn', 'pnpm', 'cargo', 'go'].includes(leader)) {
    const sub = tokens[1];
    // `npm test` ok; `npm install`/`npm ci` run arbitrary lifecycle scripts.
    return Boolean(sub) && SAFE_PKG_SUB.has(sub);
  }
  if (['node', 'python', 'python3', 'ruby'].includes(leader)) {
    // Only treat as safe for explicit syntax/version checks; running a script
    // can do anything. (Leading \b can't match before "--", so anchor on
    // whitespace/start instead.)
    return /(^|\s)(--check|--version|--help|-v|-V|-c)(\s|$|=)/.test(segment);
  }
  if (leader === 'find') {
    // find is read-only unless it deletes or executes.
    return !/-delete\b|-exec\b|-execdir\b|-ok\b/.test(segment);
  }
  if (leader === 'sed') {
    return !/\s-i\b/.test(segment); // in-place edit writes
  }
  return true;
}

function matchesAny(patterns, value) {
  if (!Array.isArray(patterns) || !value) return false;
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern).test(value)) return true;
    } catch {
      if (value.includes(pattern)) return true; // treat as literal on bad regex
    }
  }
  return false;
}

module.exports = {
  classifyTool,
  classifyBash,
  SAFE_TOOLS,
  CAUTION_TOOLS,
  DANGER_PATTERNS,
};
