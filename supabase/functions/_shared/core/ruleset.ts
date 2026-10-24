import type { Ruleset } from './types.ts';

/**
 * Ruleset v1 — approved 2026-10-24 (docs/approvals/calc-v1.md, SRS V1.5 §9.2).
 * Projects may activate a later approved version; every snapshot records the version used.
 */
export const DEFAULT_RULESET: Ruleset = {
  version: 'v1',
  provisional: false,
  testStatusAliases: {
    passed: 'Passed',
    pass: 'Passed',
    ok: 'Passed',
    success: 'Passed',
    failed: 'Failed',
    fail: 'Failed',
    'not passed': 'Failed',
    blocked: 'Blocked',
    block: 'Blocked',
    'on hold': 'Blocked',
    'not tested': 'Not Tested',
    'not run': 'Not Tested',
    'not executed': 'Not Tested',
    'no run': 'Not Tested',
    pending: 'Not Tested',
    'to do': 'Not Tested',
    todo: 'Not Tested',
  },
  defectStatusAliases: {
    new: 'Open',
    open: 'Open',
    reopened: 'Open',
    're-opened': 'Open',
    assigned: 'Open',
    'in progress': 'Open',
    closed: 'Closed',
    resolved: 'Closed',
    fixed: 'Closed',
    verified: 'Closed',
    done: 'Closed',
  },
  severityCategories: ['Critical', 'High', 'Medium', 'Low'],
  severityAliases: {
    critical: 'Critical',
    blocker: 'Critical',
    s1: 'Critical',
    high: 'High',
    major: 'High',
    s2: 'High',
    medium: 'Medium',
    moderate: 'Medium',
    s3: 'Medium',
    low: 'Low',
    minor: 'Low',
    trivial: 'Low',
    s4: 'Low',
  },
  priorityCategories: ['P1', 'P2', 'P3', 'P4'],
  priorityAliases: {
    p1: 'P1',
    urgent: 'P1',
    highest: 'P1',
    p2: 'P2',
    high: 'P2',
    p3: 'P3',
    medium: 'P3',
    normal: 'P3',
    p4: 'P4',
    low: 'P4',
    lowest: 'P4',
  },
  columnAliases: {
    testCaseId: ['test case id', 'tc id', 'test id', 'testcase id', 'tc no', 'tc #', 'test case no', 'case id'],
    status: ['status', 'test status', 'execution status', 'result', 'test result'],
    executedAt: ['executed at', 'execution date', 'executed on', 'run date', 'test date', 'date executed'],
    module: ['module', 'module name', 'feature', 'component'],
    defectId: ['defect id', 'bug id', 'defect', 'bug', 'issue id', 'defect no'],
    defectStatus: ['defect status', 'bug status', 'issue status'],
    severity: ['severity', 'defect severity', 'bug severity'],
    priority: ['priority', 'defect priority', 'bug priority'],
  },
  excludedSheetPatterns: ['^summary', '^config', '^configuration', '^lookup', '^readme', '^instructions', '^dashboard', '^lists?$'],
  dateOrder: 'DMY',
  passRatioDenominator: 'totalTc',
  otherStatuses: ['Blocked', 'Not Tested'],
  defectPopulation: { severity: 'all', priority: 'all' },
  dsi: {
    version: 'dsi-v1',
    weights: { Critical: 10, High: 5, Medium: 3, Low: 1 },
    population: 'open',
    denominator: 'defects',
    missingSeverity: 'fail',
    decimals: 2,
  },
  sourcePrecedence: {},
  staleThresholdMinutes: 15,
};

/** Shallow-merge a project override onto the default ruleset. */
export function resolveRuleset(override: Partial<Ruleset> | null | undefined): Ruleset {
  if (!override) return DEFAULT_RULESET;
  return {
    ...DEFAULT_RULESET,
    ...override,
    columnAliases: { ...DEFAULT_RULESET.columnAliases, ...(override.columnAliases ?? {}) },
    defectPopulation: { ...DEFAULT_RULESET.defectPopulation, ...(override.defectPopulation ?? {}) },
  };
}
