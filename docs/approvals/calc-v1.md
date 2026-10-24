# Approval record — Overall Detailed Table & calculation rules v1 (SRS V1.5 Phase 3)

| Field | Value |
|---|---|
| Record | APPROVAL-CALC-v1 → ruleset `v1` |
| SRS | Informatics QA LiveSync SRS V1.5 §4 Phase 3, §7–§9 |
| Date | 2026-10-24 |
| Approved by | Project owner (in Claude Code session) |
| Reference | Canvas board "Phase 3 · Overall Detailed Table & calculation rules", https://claude.ai/artifact/MCXGTyQS7sKWoiSfZ87fCv (version 11) |
| Decision | **YES — "Do you approve the Overall Detailed Table structure and calculation rules?"** |

## Overall Detailed Table
Grouped Project › Main module › Submodule, with main-module totals. Columns:
- Project, Main Module, Submodule
- Total TC, Passed, Failed, Blocked, Not Tested
- Test Pass Ratio
- Open Defects, Closed Defects
- Defect Severity (Critical · High · Medium · Low)
- Defect Priority (P1 · P2 · P3 · P4)
- DSI
- Source Document / Sheet, Last Sync / Snapshot, Validation Status

It is sortable, searchable, paginated, responsive and exportable, and uses the same filters as the charts. Counts can never be edited by hand.

## Business rules (§9.2)

| # | Rule | Approved value |
|---|---|---|
| 1 | Test Pass Ratio | `Passed ÷ Total TC × 100`. Zero Total TC → N/A. Rounded to 1 dp at display only. |
| 2 | "Other" (Module by OverAll) | `Blocked + Not Tested`, so Pass + Failed + Other = Total TC. |
| 3 | DSI | Weights Critical 10, High 5, Medium 3, Low 1. Included population: **open** defects. `DSI = Σ weights ÷ count of included defects`. Zero included defects → N/A. 2 dp at display. A defect with no severity fails validation. |
| 4 | Open/Closed mapping | Open = New, Open, Reopened, Assigned, In Progress. Closed = Closed, Resolved, Fixed, Verified. Any other status is unmapped and blocks publication. |
| 5 | Severity / priority | Categories Critical/High/Medium/Low and P1–P4. Charts 6–7 include **all** defects (open + closed). |
| 6 | Attribution & repeats | Every test case and defect belongs to exactly one submodule, the tab it came from. The same ID in two submodules of one main module is a conflict. For repeated rows the most recent execution date wins, and same-date conflicting statuses block publication. |
| 7 | Time window | Current state of every case. No date filter. |
| 8 | Missing / unknown statuses | Never coerced. The run fails validation, the last validated snapshot is retained, and the offending rows are reported. |

## Chart titles (exact)
1. Module Registration by Total Number of TC
2. Module by OverAll
3. Test Status by Module
4. Total Open Defects vs. Closed Defects
5. Total Open Defects vs. Closed Defects by Module
6. Defect Severity By Module
7. Defect Priority by Module
8. DSI by Module

## KPI labels (exact)
Total Number of TC · Test Cases Passed · Total Open Defects · Test Pass Ratio

## Change control
A material change to the schema or formulas requires a new approval version. Routine valid syncs do not.
