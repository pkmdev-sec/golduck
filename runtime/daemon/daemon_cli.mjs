#!/usr/bin/env node
/* Simple CLI for the daemon: start | stop | reload | status */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const HERE = new URL('.', import.meta.url).pathname;
const BOOT = join(HERE, 'boot.mjs');
const cmd = process.argv[2] || 'status';
const map = { start: 'up', stop: 'down', status: 'status', reload: 'status' };
const m = map[cmd];
if (!m) { console.error('usage: golduck daemon start|stop|status|reload'); process.exit(2); }
const r = spawnSync(process.execPath, [BOOT, m], { stdio: 'inherit' });
process.exit(r.status || 0);
