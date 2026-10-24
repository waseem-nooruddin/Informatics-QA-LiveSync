// Generate the XLSX workbooks used by the end-to-end acceptance tests (SRS V1.5 hierarchy).
import { mkdirSync, writeFileSync } from 'node:fs';
import * as XLSX from 'xlsx';

const H = ['Test Case ID', 'Title', 'Status', 'Execution Date', 'Defect ID', 'Defect Status', 'Severity', 'Priority'];
const rows = (prefix, statuses, defects = []) => [H, ...statuses.map((s, i) => [`${prefix}-${String(i + 1).padStart(3, '0')}`, `Case ${i + 1}`, s, '2026-10-01', ...(defects[i] ?? [])])];

function book(path, sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, data] of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), name);
  writeFileSync(path, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

mkdirSync('e2e/fixtures', { recursive: true });
const userCreation = rows('UC', ['Passed', 'Failed', 'Blocked', 'Not Tested', 'Passed'], [[], ['BUG-1', 'Open', 'High', 'P1'], ['BUG-2', 'Closed', 'Low', 'P3']]);

// EDCS › User Management: summary (excluded) + 2 submodules → 8 TC, 4 passed, 1 open defect
book('e2e/fixtures/um-v1.xlsx', [
  ['Summary', [['Overall summary'], ['generated']]],
  ['User Creation', userCreation],
  ['User Roles', rows('UR', ['Passed', 'Passed', 'Failed'])],
]);
// v2: one more passed case in User Roles and a new "Permissions" tab → 3 submodules, 10 TC
book('e2e/fixtures/um-v2.xlsx', [
  ['Summary', [['Overall summary']]],
  ['User Creation', userCreation],
  ['User Roles', rows('UR', ['Passed', 'Passed', 'Failed', 'Passed'])],
  ['Permissions', rows('PM', ['Passed'])],
]);
// EDCS › HRMS → 3 TC
book('e2e/fixtures/hrms-v1.xlsx', [
  ['Leave', rows('LV', ['Passed', 'Failed'])],
  ['Payroll', rows('PY', ['Passed'])],
]);
// A second workbook whose tab collides with the existing "User Roles" submodule → review queue
book('e2e/fixtures/um-collision.xlsx', [['User Roles', rows('XR', ['Passed'])]]);
// DIE › User Management: same names and overlapping TC ids as EDCS — must never merge
book('e2e/fixtures/die-um.xlsx', [['User Roles', rows('UR', ['Passed', 'Not Run'])]]);
// DIE invalid: unknown status → VAL-005 fails, previous snapshot retained
book('e2e/fixtures/die-invalid.xlsx', [['User Roles', rows('UR', ['Passed', 'Maybe'])]]);
// DIE renamed worksheet (same sheet position/id) → same submodule, no duplicate
book('e2e/fixtures/die-renamed.xlsx', [['Roles & Access', rows('UR', ['Passed', 'Passed'])]]);
console.log('fixtures written to e2e/fixtures');
