/* Visual smoke: pipe the smoke through script(1) so ink paints a real frame,
 * then strip ANSI + extract the final frame by taking everything after the
 * last clear-screen/cursor-home sequence. Prints a human-readable snapshot.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const smoke = join(here, 'tui_smoke.mjs');

const cols = parseInt(process.env.GOLDUCK_COLS || '140', 10);
const rows = parseInt(process.env.GOLDUCK_ROWS || '40',  10);

const proc = spawn('script', ['-q', '/dev/null', 'node', smoke], {
  stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, COLUMNS: String(cols), LINES: String(rows) },
});

const bufs = [];
proc.stdout.on('data', (c) => bufs.push(c));
proc.on('close', () => {
  const raw = Buffer.concat(bufs).toString('utf8');
  // Split on "clear screen + home cursor" which log-update emits before each frame.
  const frames = raw.split(/\x1b\[2J\x1b\[3J\x1b\[H/);
  const last = (frames[frames.length - 1] || raw)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\r/g, '')
    .replace(/\x0f/g, '');
  console.log('\n────── golduck TUI visual snapshot ──────');
  console.log(last);
  console.log('────── end snapshot ──────');
  process.exit(0);
});
