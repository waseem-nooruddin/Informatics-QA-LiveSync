# QA LiveSync

Implements **SRS V1.5**, which supersedes V1.1/V1.2. It is a multi-project QA dashboard with the hierarchy **Home → Project → Main Module → Submodules · Overall Dashboard · Detailed Dashboard**, discovered from approved Google Drive mappings.

Data comes from Google Sheets/Drive, OneDrive and uploaded workbooks. Every sync runs five automated validation gates and publishes atomically, per project, only when they all pass.

- **Approvals:** `docs/approvals/ui-v1.md` (UI) and `docs/approvals/calc-v1.md` (table and formulas, ruleset `v1`)
- **Status and evidence:** `docs/CHECKLIST.md` (Supervisor checklist)
- **UI preview (approved):** https://claude.ai/artifact/MCXGTyQS7sKWoiSfZ87fCv

## Architecture

```
GitHub Pages (static React app, anon key only)
        │  reads curated aggregate views + Realtime on project_state
        ▼
Supabase ── Postgres (RLS, composite project/main-module FKs, immutable snapshots, atomic publish)
        ├── pg_cron */3 * * * * → sync-dispatch → one sync-project per project
        ├── Edge Functions: admin-api (projects, main modules, Drive Picker flows, review queue),
        │                   sync-dispatch, sync-project, oauth-callback
        ├── Vault (encrypted OAuth tokens; browser only ever gets a short-lived Picker token)
        └── Realtime (project_state → live status + new snapshot id)
```

| Path | Contents |
|---|---|
| `packages/core` | Engine, unit-tested: discovery (main-module scoped, quarantine), normalization, dedup (calc rule 6), table, 8 charts, `selectScope` (Overall/Detailed/filters/exports), the 5 gates, approved DSI |
| `supabase/functions/_shared/core` | **Generated** copy of `packages/core/src` (`npm run sync:core`; CI fails on drift) |
| `supabase/functions` | Adapters (`google`, `drive`, `microsoft`, `upload`), sync worker, admin API (`admin-api/hierarchy.ts` = V1.5 routes) |
| `supabase/migrations` | Schema, RLS/views, RPCs, scheduler, Vault credentials, `…005_hierarchy.sql` (V1.5) |
| `apps/web` | React, Vite, Tailwind v4, Recharts, TanStack Query/Table. Navy `#0B2858` / white / sky `#38BDF8`. |
| `e2e` | Playwright acceptance tests mapped to V1.5 AT-xx |

## Approved rules (ruleset v1)

| Rule | Approved value |
|---|---|
| Pass ratio | Passed ÷ Total TC (N/A on zero) |
| "Other" | Blocked + Not Tested |
| DSI | Weights Critical 10 / High 5 / Medium 3 / Low 1 · open defects only · Σ weights ÷ count · zero → N/A |
| Open | New, Open, Reopened, Assigned, In Progress |
| Closed | Closed, Resolved, Fixed, Verified (other statuses block publication) |
| Severity / priority charts | All defects |
| Attribution | Every case or defect belongs to exactly one submodule (its tab); latest execution wins |
| Time window | Current state |
| Unknown statuses | Block publication, never coerced |

**Hierarchy rule:** the Drive folder picked with **+ Add New Project** is the project. Its subfolders, once confirmed, become main modules. Sources added with a main module's **+ Add** belong only to it. Each valid sheet tab becomes a submodule.

Ambiguous cases go to the review queue on *Data sources & review*: new folders, tab-name collisions, and sources on unknown main modules. Nothing is guessed.

## Local development

Prerequisites: Node 22+ and Docker Desktop.

```bash
npm install
npm run db:start                    # applies migrations + seed (EDCS, DIE, local admin key)
npx supabase status -o env          # → apps/web/.env.local: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
cp supabase/.env.example supabase/.env.local
npm run functions:serve
npm run dev                         # http://localhost:5180
```

- **Admin key:** `local-dev-admin-key-0000`. Enter it in a project's Settings.
- **Sample data:** `npm run fixtures` writes `e2e/fixtures/*.xlsx`. Upload one through *Data sources & review → Upload workbook* on a main module.

## Tests

```bash
npm test            # engine (Vitest)
npm run typecheck   # core + web + Edge Functions
npm run db:test     # pgTAP
PW_CHANNEL=chrome SUPABASE_ANON_KEY=<anon key> npx playwright test   # acceptance (needs db + functions)
```

## Enabling Google Drive (FR-GD-001..008)

1. In Google Cloud, enable the **Google Picker API**, **Drive API** and **Sheets API**.
2. Create an **OAuth client (Web)** with redirect URI `https://<ref>.supabase.co/functions/v1/oauth-callback` and scopes `drive.readonly` + `spreadsheets.readonly`.
3. Create a **browser API key** restricted to the app origins.
4. Set the function secrets `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_PICKER_API_KEY` and `GOOGLE_CLOUD_PROJECT_NUMBER`.
5. In the app: Project Hub → **+ Add New Project** → *Connect Google account* (once), then choose the folder.

## Production deployment

Same as before:
- Supabase project + Vault secrets (`qals_functions_url`, `qals_worker_secret`)
- `supabase db push && supabase functions deploy`
- `node scripts/create-admin-key.mjs`
- GitHub Pages workflow with `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`

Do **not** run `seed.sql` in production. The access model is Option A (public aggregates); revisit it before publishing confidential data.

## Open items
See `docs/CHECKLIST.md`:
- **Google Cloud:** provide the credentials above, then create the first project from the recorded Drive folder.
- **Hosting:** create a hosted Supabase project (the GitHub repo is `waseem-nooruddin/QA-LiveSync`).
