#!/usr/bin/env node
/** check-syntax.mjs — parse every app JS file with `node --check` (catches typos before deploy). */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../app/js', import.meta.url));
const files = readdirSync(root, { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => join(root, f));
let failed = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { failed++; console.error(`✗ ${f}\n${e.stderr}`); }
}
console.log(`${files.length - failed}/${files.length} files parse cleanly`);
process.exit(failed ? 1 : 0);
