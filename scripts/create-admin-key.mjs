// Generate an admin key and the SQL to register its SHA-256 hash.
// Usage: node scripts/create-admin-key.mjs "<label>" [platform|<projectId>]
// The clear key is printed once; only the hash is stored in the database.
import { createHash, randomBytes } from 'node:crypto';

const label = process.argv[2] ?? 'admin';
const scope = process.argv[3] ?? 'platform';
const key = `qals_${randomBytes(32).toString('base64url')}`;
const hash = createHash('sha256').update(key).digest('hex');
const q = (s) => `'${s.replace(/'/g, "''")}'`;
console.log(`Admin key (store it in a password manager, it is shown once):\n\n  ${key}\n`);
console.log(`Run in the Supabase SQL editor:\n\n  insert into public.admin_keys (label, key_hash, scope) values (${q(label)}, ${q(hash)}, ${q(scope)});\n`);
