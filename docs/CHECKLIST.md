# Supervisor checklist — Informatics QA LiveSync (SRS V1.5)

Statuses: Not Started · In Progress · Blocked · Implemented · Tested · **Verified** (evidence below) · Deployed.
"Verified" means a test or recorded approval proves it. Writing the code is not enough.
Last audit: 2026-10-24.

**Evidence commands** (all run on 2026-10-24, all passing):
- **E1 — Engine tests:** `npm test`, 38/38 (`packages/core/test/*.test.ts`)
- **E2 — Database tests:** `npx supabase test db`, 25/25 (`supabase/tests/database.test.sql`)
- **E3 — Browser acceptance tests:** 13/13. Command: `PW_CHANNEL=chrome SUPABASE_ANON_KEY=<local anon key> npx playwright test` (`e2e/acceptance.spec.ts`)
- **E4 — Typecheck:** `npm run typecheck` (core + web + Edge Functions)
- **E5 — Build:** `npm run build`

## Approval gates (§4)

| Req | Status | Evidence |
|---|---|---|
| Phase 0 prerequisites (YES) | Verified | Session record, 2026-10-24 |
| AT-01 Phase 1 YES → Plan Mode → plan approved | Verified | Session record; plan approved before any code change |
| AT-02 UI previews before frontend coding, 6 items recorded | Verified | `docs/approvals/ui-v1.md`; preview canvas v10 |
| AT-03 UI NO blocks implementation and triggers a revision | N/A | Approval was YES; the NO path is documented in the process |
| AT-04 Table and formula approval | Verified | `docs/approvals/calc-v1.md`; `approval_records` rows in migration 005 |

## Navigation and hierarchy (§5)

| Req | Status | Evidence |
|---|---|---|
| AT-05 Homepage: official logo, branding, Open Dashboard | Verified | Official logo supplied 2026-10-24 → `apps/web/src/assets/brand/` (original kept unchanged); E3 "AT-05" |
| AT-06 Project Hub lists projects, no hardcoded limits | Verified | E3 "AT-06" |
| AT-07 Sidebar: Project → Main Module → Submodules + Overall + Detailed + "+ Add" | Verified | E3 "AT-07/AT-11/AT-14" |
| AT-08 Hierarchy from approved Drive mapping, not labels | Tested | E1 hierarchy suite. The live Drive folder walk needs Google credentials (see FR-GD). |
| AT-09 New validated submodule appears under the correct main module | Verified | E1 "AT-09"; E3 "AT-09/AT-19" |
| AT-10 Ambiguous mapping → review, never auto-created | Verified | E1 "AT-10"; E3 "AT-10"; `mapping_reviews` queue |
| AT-11 Overall Dashboard = only that main module | Verified | E1 scope suite; E3 (8 TC with HRMS excluded) |
| AT-12 Detailed filter (All / one / several) drives KPIs, 8 charts, table, export | Verified | E1 "Detailed Dashboard…"; E3 "AT-12" |

## Metrics (§7–§9)

| Req | Status | Evidence |
|---|---|---|
| AT-14 Four KPIs and eight charts, exact titles and approved formulas | Verified | E3 title check. E1 reproduces the Phase 3 sample: 90 / 62 / 68.9% / Other 13 / DSI 65÷12. |
| AT-15 Status rows sum to 100% before rounding | Verified | E1 "AT-15" |
| AT-16 Deduplication and latest-execution precedence | Verified | E1 duplicate, latest-run and calc-rule-6 tests |
| AT-17 Five gates pass before atomic publication | Verified | E1; E2 publish ordering; live smoke run showed all gates "Passed" |
| AT-18 Failed sync keeps the last valid snapshot and marks it failed | Verified | E3 "AT-18" |

## Sync, security, operations (§10–§12)

| Req | Status | Evidence |
|---|---|---|
| AT-13 Cross-project isolation (DB, API, snapshots, exports) | Verified | E1 isolation; E2 composite FKs and Drive-root uniqueness; E3 "AT-13" |
| AT-19 Sync about every 3 min, independent of laptops; colleagues see updates | Tested (local) | pg_cron job + E3 live-update test. Hosted run pending deployment (AT-24). |
| AT-20 No credentials in frontend, logs or repo | Tested | Vault-encrypted tokens; CI bundle secret scan; log redaction (`_shared/http.ts`) |
| AT-21 Unauthorized users can't add or administer | Verified | E3 "AT-21": 401 on admin and Drive endpoints. Private viewing is out of scope under the Option A decision. |
| AT-22 Mobile navigation, keyboard, contrast | Tested | E3 "AT-22". Colour pairs validated in UI v1. No automated axe audit yet. |
| AT-23 This checklist reports verified, pending and blocked with evidence | Verified | This file |
| AT-24 Deployed site, backups, health checks, rollback | **Not Started** | Needs a hosted Supabase project and a GitHub repo (workflows ready in `.github/workflows`) |

## Google Drive add actions (§5.3)

| Req | Status | Evidence |
|---|---|---|
| FR-GD-001 + Add New Project opens the Drive folder picker; URL fallback | Implemented | `DriveDialogs.tsx`, `lib/drivePicker.ts`. Error path verified in E3. **Live picker blocked on Google API key / OAuth client.** |
| FR-GD-002 Preview → "Create this project…? YES / NO"; NO changes nothing | Tested | Server refuses without `confirm: 'YES'` (E3). Live preview needs Google credentials. |
| FR-GD-003 + Add on each main module, scoped to project → main module | Verified (scope) | E3 sidebar "+" link and "+ Add scope" test (attachment only affects that main module) |
| FR-GD-004 Source preview → "Add these … to [P] → [M]? YES / NO" | Implemented | `/main-modules/:mid/sources/preview` and `/sources`; server checks the confirm, project and main module |
| FR-GD-005 Short-lived picker token only; read-only; role checks | Tested | `/picker-config` mints access tokens only; refresh tokens stay in Vault; E3 401 test |
| FR-GD-006 Stable ids, duplicate and cross-project detection, no double counting | Tested | DB unique source per project + cross-project trigger; E2 root uniqueness; preview flags |
| FR-GD-007 Loading, cancel (no change), denied, failure states; unlink with impact preview | Implemented | `DriveDialogs.tsx`; `/sources/:sid/impact` + Unlink dialog |
| FR-GD-008 OneDrive remains supported | Tested | Microsoft adapter unchanged; typechecked (E4) |

## Open items (owner action)
1. ~~Logo~~ — supplied and in place (2026-10-24). A vector (SVG) version would render sharper at large sizes.
2. **Project Drive folder (deferred by owner):** `https://drive.google.com/drive/folders/1de5c5dFZdaI57qbnrU7ho5FXAJM388P0` is the intended source root for **+ Add New Project** once Google credentials exist.
3. **Google Cloud:** enable the Picker and Drive APIs; create a browser API key (`GOOGLE_PICKER_API_KEY`) and an OAuth web client; set `GOOGLE_CLOUD_PROJECT_NUMBER`. This unblocks the live verification of FR-GD-001/002/004 and AT-08.
4. **Hosting:** GitHub repo `waseem-nooruddin/Informatics-QA-LiveSync` (public) provided; hosted Supabase project still needed for AT-24.
5. **Access model:** Option A is accepted for now. Revisit before confidential data is published (§12).
