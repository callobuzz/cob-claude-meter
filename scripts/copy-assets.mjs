// tsc only emits .ts output, so the dashboard's static files need copying
// into dist/ as part of the build.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'src', 'server', 'public');
const to = join(root, 'dist', 'server', 'public');

if (!existsSync(from)) {
  console.error(`copy-assets: missing source directory ${from}`);
  process.exit(1);
}

mkdirSync(dirname(to), { recursive: true });
cpSync(from, to, { recursive: true });
console.log(`copy-assets: ${from} -> ${to}`);
