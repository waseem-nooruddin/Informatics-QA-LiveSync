# Approval record — UI v1 (SRS V1.5 Phase 2)

| Field | Value |
|---|---|
| Record | APPROVAL-UI-v1 |
| SRS | Informatics QA LiveSync SRS V1.5 §4 Phase 2 |
| Date | 2026-10-24 |
| Approved by | Project owner (in Claude Code session) |
| Preview | https://claude.ai/artifact/MCXGTyQS7sKWoiSfZ87fCv (private canvas, version 10) |
| Decision | **YES — "Do you approve the proposed Informatics QA LiveSync UI design?"** |

## Itemised decisions

| # | Item | Decision |
|---|---|---|
| 1 | Dashboard style and layout: navy sidebar tree, white content, KPI cards, 8 charts in a two-column grid, Overall and Detailed as separate main-module pages | YES |
| 2 | Palette: navy `#0B2858`, white `#FFFFFF`, sky `#38BDF8` (accent only, never body text); status colours Passed green / Failed red / Blocked orange / Not Tested blue / Other slate; severity dark→light reds, priority dark→light blues | YES |
| 3 | Naming: product "Informatics QA LiveSync"; pages Project Hub, Overall Dashboard, Detailed Dashboard, Data sources & review; KPI and chart titles exactly as SRS V1.5 §8–§9 | YES |
| 4 | Logo placement: large in the homepage hero, small in the sidebar header and mobile top bar, original aspect ratio | YES — **logo file still to be supplied**; a "pending" slot is shown until it is |
| 5 | Animations | **YES**: restrained transitions only, disabled under `prefers-reduced-motion` |
| 6 | Desktop/mobile presentation and the dynamic nested navigation (Home → Project → Main Module → Submodules + Overall Dashboard + Detailed Dashboard; + Add per main module; + Add New Project; mobile slide-in drawer) | YES |

## Conditions
- The real Informatics logo must replace every placeholder before release (SRS §3). No substitute logo may be generated.
- Previews used sample data only. They are design proposals, not evidence of implemented functionality (SRS §4).
- Any material change to the layout or navigation needs a new UI approval version.
