// Vendor packages/core/src into supabase/functions/_shared/core so Edge Functions (Deno)
// run exactly the same validation engine as the tests. Run after any core change;
// CI fails if the copy is out of date (`node scripts/sync-core.mjs --check`).
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const src = 'packages/core/src';
const dst = 'supabase/functions/_shared/core';
const check = process.argv.includes('--check');

if (check) {
  const files = readdirSync(src);
  const stale = files.filter((f) => !existsSync(join(dst, f)) || readFileSync(join(src, f), 'utf8') !== readFileSync(join(dst, f), 'utf8'));
  const extra = existsSync(dst) ? readdirSync(dst).filter((f) => !files.includes(f)) : [];
  if (stale.length || extra.length) {
    console.error(`Edge function core copy is out of date: ${[...stale, ...extra].join(', ')}. Run: node scripts/sync-core.mjs`);
    process.exit(1);
  }
  console.log('core copy up to date');
} else {
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true });
  console.log(`copied ${src} -> ${dst}`);
}
