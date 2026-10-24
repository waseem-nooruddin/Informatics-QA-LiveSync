import { defectKey, testKey, testMainKey } from './identity.ts';
import type { Conflict, DedupDecision, DefectRecord, TestRecord } from './types.ts';

export interface CanonicalTest extends TestRecord {
  /** All execution records for this canonical test case, history preserved (FR-DEDUP-002). */
  executions: TestRecord[];
}

export interface DedupResult {
  tests: CanonicalTest[];
  defects: DefectRecord[];
  decisions: DedupDecision[];
  conflicts: Conflict[];
  duplicates: number;
}

/**
 * Collapse records to canonical identities.
 * - Identical repeats are duplicates (kept once, logged).
 * - Differing statuses resolve to the latest execution date when strictly later;
 *   otherwise an unresolved conflict that blocks publication (FR-DEDUP-004/006).
 */
export function dedupe(tests: TestRecord[], defects: DefectRecord[]): DedupResult {
  const out: DedupResult = { tests: [], defects: [], decisions: [], conflicts: [], duplicates: 0 };

  // calc-v1 rule 6: a test case belongs to exactly one submodule within its main module.
  const multi = new Set<string>();
  for (const [key, recs] of group(tests, testMainKey)) {
    const subs = new Set(recs.map((r) => r.moduleId));
    if (subs.size > 1) {
      multi.add(key);
      out.conflicts.push({
        kind: 'test-multi-submodule',
        key,
        moduleId: recs[0]!.moduleId,
        detail: `Test case ${recs[0]!.testCaseId} appears in several submodules (${[...subs].join(', ')}) of one main module`,
        refs: recs.map((r) => r.lineage),
      });
    }
  }
  tests = tests.filter((t) => !multi.has(testMainKey(t)));

  const tGroups = group(tests, testKey);
  for (const [key, recs] of tGroups) {
    if (recs.length === 1) {
      out.tests.push({ ...recs[0]!, executions: recs });
      continue;
    }
    const statuses = new Set(recs.map((r) => r.status));
    if (statuses.size === 1) {
      const latest = latestOf(recs) ?? recs[0]!;
      out.duplicates += recs.length - 1;
      out.decisions.push({
        kind: 'test-duplicate',
        key,
        kept: latest.lineage,
        superseded: recs.filter((r) => r !== latest).map((r) => r.lineage),
        reason: 'identical status repeated',
      });
      out.tests.push({ ...latest, executions: recs });
      continue;
    }
    const latest = latestOf(recs);
    if (latest) {
      out.decisions.push({
        kind: 'test-latest-status',
        key,
        kept: latest.lineage,
        superseded: recs.filter((r) => r !== latest).map((r) => r.lineage),
        reason: `latest execution ${latest.executedAt} wins`,
      });
      out.tests.push({ ...latest, executions: recs });
    } else {
      out.conflicts.push({
        kind: 'test-status',
        key,
        moduleId: recs[0]!.moduleId,
        detail: `Test case ${recs[0]!.testCaseId} has conflicting statuses (${[...statuses].join(', ')}) without a strictly latest execution date`,
        refs: recs.map((r) => r.lineage),
      });
    }
  }

  const dGroups = group(defects, defectKey);
  for (const [key, recs] of dGroups) {
    const first = recs[0]!;
    if (recs.length === 1) {
      out.defects.push(first);
      continue;
    }
    const modules = new Set(recs.map((r) => r.moduleId));
    if (modules.size > 1) {
      out.conflicts.push({
        kind: 'defect-module',
        key,
        detail: `Defect ${first.defectId} is attributed to multiple modules (${[...modules].join(', ')})`,
        refs: recs.map((r) => r.lineage),
      });
      continue;
    }
    const sig = (d: DefectRecord) => `${d.lifecycle}|${d.severity ?? ''}|${d.priority ?? ''}`;
    if (new Set(recs.map(sig)).size > 1) {
      out.conflicts.push({
        kind: 'defect-attributes',
        key,
        moduleId: first.moduleId,
        detail: `Defect ${first.defectId} has conflicting status/severity/priority across rows`,
        refs: recs.map((r) => r.lineage),
      });
      continue;
    }
    out.duplicates += recs.length - 1;
    out.decisions.push({
      kind: 'defect-duplicate',
      key,
      kept: first.lineage,
      superseded: recs.slice(1).map((r) => r.lineage),
      reason: 'same defect referenced by multiple rows',
    });
    out.defects.push(first);
  }
  return out;
}

function group<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

/** The record with the strictly greatest executedAt, or null if absent/tied. */
function latestOf(recs: TestRecord[]): TestRecord | null {
  if (recs.some((r) => !r.executedAt)) return null;
  const sorted = [...recs].sort((a, b) => b.executedAt!.localeCompare(a.executedAt!));
  if (sorted.length > 1 && sorted[0]!.executedAt === sorted[1]!.executedAt) {
    // Tied timestamps are only safe when they agree on status.
    return sorted[0]!.status === sorted[1]!.status ? sorted[0]! : null;
  }
  return sorted[0]!;
}
