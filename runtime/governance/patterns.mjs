/* ─────────────────────────────────────────────────────────────────────────
 * golduck shared risk-pattern catalog (runtime/governance/patterns.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Single source of truth for "dangerous command" and "prompt injection"
 * regex sets. Before this module existed, three separate files each
 * carried their own arrays:
 *
 *   runtime/engine/safety.mjs         HARD_BLOCK_PATTERNS  (shell veto)
 *   runtime/governance/gates.mjs      DANGEROUS_COMMANDS   (prompt veto)
 *                                     INJECTION_PATTERNS   (prompt flag)
 *   runtime/engine/engine.mjs         INJECTION_PATTERNS   (tool result sniff)
 *
 * They drifted. This module unifies them, exports typed helpers, and
 * lets every call site trust the same rules. Adding a new pattern means
 * editing exactly one place.
 *
 * Exports:
 *   HARD_BLOCK_PATTERNS        — shell / prompt hard-veto (irreversible)
 *   INJECTION_PATTERNS         — prompt-injection fingerprints
 *   findHardBlock(str)         — returns {pattern, match} or null
 *   findInjection(str)         — returns {pattern, match} or null
 *   isDangerousShellLike(str)  — lighter check for tool-result/shell sniff
 *
 * Patterns here are additive of the historical three: superset of each.
 * ───────────────────────────────────────────────────────────────────────── */

/** Irreversible, always-vetoed shell commands or prompt strings. */
export const HARD_BLOCK_PATTERNS = [
  /\brm\s+-rf\s+\/($|\s)/,                    // rm -rf /
  /\brm\s+-rf\s+~($|\s|\/)/,                  // rm -rf ~
  /\bsudo\s+rm\s+-rf?\s+\//,                 // sudo rm -rf /anything — no
  /\bchmod\s+-R\s+777\s+\//,                 // chmod -R 777 / anything
  /\bchmod\s+0?777\s+\/(etc|var|usr|bin|sbin|lib|boot)\b/, // chmod 777 system dir
  /mkfs\./,                                    // filesystem wipe
  /dd\s+if=.+of=\/dev\/(sd|hd|nvme|disk)/,    // raw disk dd
  /\bbash\s+-c\s+['"']?\s*>\s*\/dev\/tcp\//, // reverse shell via /dev/tcp
  /\becho\b.*>\s*\/proc\//,                 // write to /proc/*
  /\becho\b.*>\s*\/sys\//,                  // write to /sys/*
  /\brm\s+-rf?\s+~\/\.(aws|ssh|config|gnupg|password-store|kube)\b/, // secrets/config destruction
  /\bgit\s+filter-branch\b.*--all/,          // history rewrite across refs
  /\bgit\s+update-ref\s+-d\s+refs\/heads\/(main|master)\b/, // delete main branch ref
  /\bhistory\s+-c\b/,                         // clear shell history
  /\bhistory\s+-w\s+\/dev\/null/,           // history → /dev/null
  /\bcrontab\s+-r\b/,                         // wipe crontab
  /\bumount\s+-a\b/,                          // unmount all filesystems
  /\biptables\s+-F\b|\bufw\s+disable\b/,   // disable firewall
  /\bsysctl\s+-w\s+kernel\./,                 // kernel tuning writes
  /:\(\)\s*\{\s*:\s*\|\s*:\s*;\s*\}\s*;\s*:/, // fork bomb (full form)
  /:\(\)\s*\{\s*:/,                           // fork-bomb opener (shorthand)
  /shutdown\s+-[hr]/i,
  /\bhalt\b/i,
  /\bpoweroff\b/i,
  /\breboot\b/i,
  /curl[^|\n]*\|\s*(sudo\s+)?(bash|sh|zsh|ksh|fish)\b/, // curl | sh
  /wget[^|\n]*\|\s*(sudo\s+)?(bash|sh|zsh|ksh|fish)\b/, // wget | sh
  /aws\s+s3\s+rb\s+s3:\/\/.*--force/,         // bucket destruction
  /gcloud\s+projects\s+delete/,               // GCP project delete
  /kubectl\s+delete\s+(ns|namespace|pods?)\s+--all/, // mass k8s delete
  /docker\s+(volume\s+rm|system\s+prune)\s+.*(-a|--all|-f|--force)/,
  /terraform\s+destroy(\s|$)/,                 // infra tear-down
  /git\s+push\s+(-f|--force)\b.*\b(main|master)\b/, // force-push to main
  /git\s+push\s+.*--force(-with-lease)?\b.*\b(main|master)\b/,
];

/** Jailbreak / injection fingerprints. Case-insensitive where natural. */
export const INJECTION_PATTERNS = [
  /ignore (all |any |the )?(previous|prior|preceding) (instructions|prompts?|directives)/i,
  /disregard (all )?(previous|prior) (system )?(prompts?|instructions?)/i,
  /system prompt is/i,
  /print (your )?(entire |full )?system prompt/i,
  /reveal (your )?(hidden |secret |internal )?(instructions|prompt|directives)/i,
  /\byou are now [A-Z]/,        // role-swap: "You are now DAN..."
  /\bSYSTEM:\s*/,                // embedded system role header
  /\bASSISTANT:\s*/,             // embedded assistant role header
  /\<\/?(system|assistant|user)\>/i, // xml role injection
  /exfiltrate/i,
  /leak (the |your )?(api key|token|secret|credentials)/i,
  /wipe the disk/i,
  /dan mode/i,                  // jailbreak shorthand
  /developer mode (enabled|is on)/i,
];

/**
 * Lighter-weight check for "this content contains shell-like danger".
 * Used by the tool-result sniffer and by the prompt-gate's soft warning.
 */
export function isDangerousShellLike(str) {
  if (typeof str !== 'string' || !str) return false;
  for (const re of HARD_BLOCK_PATTERNS) if (re.test(str)) return true;
  return false;
}

/**
 * Returns the first matching hard-block pattern or null.
 * Output includes a printable representation and the matched substring.
 */
export function findHardBlock(str) {
  if (typeof str !== 'string' || !str) return null;
  for (const re of HARD_BLOCK_PATTERNS) {
    const m = str.match(re);
    if (m) return { pattern: String(re), match: m[0] };
  }
  return null;
}

/** Returns the first matching injection pattern or null. */
export function findInjection(str) {
  if (typeof str !== 'string' || !str) return null;
  for (const re of INJECTION_PATTERNS) {
    const m = str.match(re);
    if (m) return { pattern: String(re), match: m[0].slice(0, 120) };
  }
  return null;
}

/** Common secret prefixes we scan for in outbound tool calls. */
export const SECRET_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/,                            // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/,                            // AWS temp
  /\bsk-[A-Za-z0-9_-]{20,}\b/,                       // OpenAI / Anthropic api-style
  /\bsk-ant-[A-Za-z0-9_-]{24,}\b/,                   // Anthropic specifically
  /\bghp_[A-Za-z0-9]{30,}\b/,                        // GitHub PAT
  /\bgho_[A-Za-z0-9]{30,}\b/,                        // GitHub OAuth
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,                    // GitLab PAT
  /\bxox[baprs]-[0-9]{10,}-[A-Za-z0-9]{10,}\b/,      // Slack
  /\b-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, // PEM key
];

export function findSecret(str) {
  if (typeof str !== 'string' || !str) return null;
  for (const re of SECRET_PATTERNS) {
    const m = str.match(re);
    if (m) return { pattern: String(re), match: m[0].slice(0, 8) + '…' };
  }
  return null;
}

/** Convenience: severity tier for logging/telemetry. */
export function severityFor(finding) {
  if (!finding) return 'ok';
  // HARD_BLOCK always wins; injection is warn unless combined with dangerous content.
  return finding.hard ? 'hard_block' : 'warn';
}
