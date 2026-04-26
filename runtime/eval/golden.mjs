/* ─────────────────────────────────────────────────────────────────────────
 * golduck eval golden set (runtime/eval/golden.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * A curated set of prompts that exercise the framework's reasoning,
 * decomposition, and verification layers. We grade each run with
 * rlm_verify-as-judge and track scores across waves.
 *
 * Tiers (prompts per tier):
 *   easy    — direct factual / small-code, minutes to answer; expect ~10s/turn.
 *   medium  — requires decomposition, uses 1-3 tool calls; ~30-60s/turn.
 *   hard    — architecture / multi-file refactor / threat model; invokes planner,
 *             best-of-N, panel-verify in full flight.
 *
 * Each prompt has:
 *   { id, tier, prompt, expect }   // expect = human-readable rubric for the judge
 *
 * Keep the set SMALL (12 prompts total) so running `golduck eval` is ~$1.50
 * and ~5 minutes, not an all-night run. The value is REGRESSION DETECTION:
 * if wave N+1 scores lower on the same prompts, something regressed.
 *
 * Stable IDs: never renumber. If a prompt goes stale, mark it deprecated,
 * don't remove — otherwise historical score comparisons break.
 * ───────────────────────────────────────────────────────────────────────── */

export const GOLDEN = [
  // ── easy ──────────────────────────────────────────────────────────────
  {
    id: 'e01',
    tier: 'easy',
    prompt: 'What is the time complexity of inserting N items into a balanced binary search tree, and why?',
    expect:
      'Correct answer is O(N log N). Explanation must mention: balanced tree height is log N; each insert is O(log N); N inserts compound to O(N log N). No hedging.',
  },
  {
    id: 'e02',
    tier: 'easy',
    prompt: 'Write a one-line JavaScript expression that returns the sum of a non-empty array of numbers.',
    expect:
      'Correct: `arr.reduce((a, b) => a + b)` or `arr.reduce((a, b) => a + b, 0)`. Must be a single expression, must handle non-empty correctly. No prose dilution.',
  },
  {
    id: 'e03',
    tier: 'easy',
    prompt: 'In Git, what is the difference between `git fetch` and `git pull`?',
    expect:
      'Must state: fetch downloads without merging; pull = fetch + merge. Bonus for mentioning pull can also do --rebase. Must not conflate.',
  },
  {
    id: 'e04',
    tier: 'easy',
    prompt: 'What does HTTP status code 409 mean, and name one concrete scenario that warrants it?',
    expect:
      '409 = Conflict. Scenario must be concrete (e.g. optimistic-lock version mismatch, concurrent update to same resource). Reject vague "conflict happened" answers.',
  },
  // ── medium ────────────────────────────────────────────────────────────
  {
    id: 'm01',
    tier: 'medium',
    prompt:
      'Explain why Python\'s GIL does not actually prevent multithreading from being useful. Give two concrete scenarios where Python threads still speed up a program.',
    expect:
      'Must explain: GIL releases during I/O-bound syscalls; C-extensions can release GIL (numpy, etc.). Two scenarios must be concrete: e.g. concurrent HTTP requests, concurrent file I/O, numpy ops over big arrays. No hand-wave.',
  },
  {
    id: 'm02',
    tier: 'medium',
    prompt:
      'You have a function `f(x)` that is slow because it allocates a big dict per call but the dict content only depends on `x`. How do you fix this in idiomatic Python? Give the 3-line solution.',
    expect:
      'Correct: `@functools.lru_cache(maxsize=None)` decorator or `@functools.cache` (3.9+). Solution must show the decorator applied above the function definition. Must note x has to be hashable.',
  },
  {
    id: 'm03',
    tier: 'medium',
    prompt:
      'Design a rate limiter that allows at most 10 requests per user per second. Explain the approach and give pseudocode. What happens at the boundary between seconds, and how does a token-bucket approach differ?',
    expect:
      'Must compare at least fixed-window vs token-bucket. Must identify the boundary-burst problem in fixed-window (up to 2N in 2 adjacent windows). Token-bucket answer: continuous refill, smooths boundary. Pseudocode must be concrete enough to implement.',
  },
  {
    id: 'm04',
    tier: 'medium',
    prompt:
      'What are the three hardest problems a distributed cache invalidation system has to solve? Name each and explain why it is hard in 2-3 sentences.',
    expect:
      'Strong candidates (must hit at least 3 of these): cache stampede/thundering herd; stale reads under eventual consistency; partial failure during multi-region invalidation; fan-out cost; atomic co-invalidation of related keys; out-of-order delivery. Each must be explained, not just listed.',
  },
  // ── hard ──────────────────────────────────────────────────────────────
  {
    id: 'h01',
    tier: 'hard',
    prompt:
      'Design a minimal file-system watcher that works on Linux, macOS, and Windows without external dependencies, in a language of your choice. Cover: API surface, per-OS backend choice, how you handle the "rename = delete + create on Windows but rename on macOS" case, and the backpressure story when events arrive faster than consumers process them.',
    expect:
      'Strong answer addresses all four parts: (1) API surface (callback or async iterator); (2) backends: inotify/fanotify for Linux, FSEvents/kqueue for macOS, ReadDirectoryChangesW for Windows; (3) normalizes rename semantics (emits unified {kind: rename, from, to}); (4) bounded queue with drop-oldest or backpressure signal. Rejects hand-wavy "use a library" answers.',
  },
  {
    id: 'h02',
    tier: 'hard',
    prompt:
      'I want to add a feature to our monorepo: every PR that touches a crate should automatically run the tests for that crate AND every crate that depends on it, transitively. Walk me through the implementation. Constraints: must work locally (so contributors can reproduce CI), must be fast (no rebuilding the world), must handle the case where a crate has no direct test target but its downstream does.',
    expect:
      'Must propose: (a) dependency graph extraction (cargo metadata --format-version 1); (b) set-of-touched-files → affected crates via cargo_toml parent walk; (c) downstream dep closure; (d) test execution on closure + ancestors with no-test crates skipped gracefully. Bonus: mentions cargo-nextest for speed, or test-selection via target-graph tools. Pushes back on the "no direct tests" edge case explicitly.',
  },
  {
    id: 'h03',
    tier: 'hard',
    prompt:
      'A user reports that our web app\'s "Export CSV" feature produces a file that Excel opens with all text in one column. We use UTF-8 encoded CSV with commas as delimiters. What is happening, what are the three most likely root causes in priority order, and what is the minimal fix for each?',
    expect:
      'Must identify: (1) Excel does not auto-detect UTF-8 without a BOM — so it reads everything as default encoding and comma-delimited file ends up in one column because Excel\'s regional default was semicolon (common in EU locales). Fix: prepend UTF-8 BOM (EF BB BF). (2) Excel does use comma when regional locale is US/UK but SEMICOLON in DE/FR — fix: emit a "sep=," line at the top OR write a proper .xlsx. (3) CSV quoting — if a cell contains an embedded comma or quote and isn\'t properly quoted, the whole row can collapse. Must prioritize BOM first.',
  },
  {
    id: 'h04',
    tier: 'hard',
    prompt:
      'Walk me through how you would architect a CLI tool that needs to (a) stream responses from multiple LLM providers in parallel, (b) dedupe their outputs token-by-token using a shared streaming stop-sequence detector, (c) emit the final merged stream to stdout, and (d) do all of this without burning more than 200MB of memory on a 10MB response. Identify the two hardest parts of this problem.',
    expect:
      'Strong answer: (1) parallel streams via async iterators, one per provider; (2) a shared stop-detector that looks at a rolling window of N chars across any stream; (3) token-level dedup requires tokenization parity across providers (hard!) — must call this out as hardest part; (4) bounded memory via back-pressured pipes + fixed rolling buffer. Second hardest: handling partial-match boundaries where stop-seq spans a chunk border. Rejects "just buffer everything".',
  },
];

export const DEPRECATED = []; // historical-comparison placeholder; add retired prompt ids here.

/** Helpers */
export function byId(id) {
  return GOLDEN.find((g) => g.id === id) || null;
}

export function byTier(tier) {
  return GOLDEN.filter((g) => g.tier === tier);
}

export function tiers() {
  return [...new Set(GOLDEN.map((g) => g.tier))];
}
