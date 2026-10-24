import type { DefectRecord, DsiFormula, DsiParts, DsiValue } from './types.ts';

export const DSI_UNAVAILABLE: DsiValue = { status: 'unavailable', reason: 'DSI formula not approved' };

/**
 * Raw DSI components for a set of defects under the approved formula (calc-v1 rule 3).
 * Kept as weighted sum + count so any scope can be recombined exactly by addition.
 */
export function dsiParts(formula: DsiFormula | null, defects: DefectRecord[]): DsiParts {
  if (!formula) return { weighted: 0, count: 0 };
  const pop = formula.population === 'open' ? defects.filter((d) => d.lifecycle === 'Open') : defects;
  let weighted = 0;
  let count = 0;
  for (const d of pop) {
    const w = d.severity ? formula.weights[d.severity] : undefined;
    if (w === undefined) {
      if (formula.missingSeverity === 'exclude') continue;
      return { weighted, count, error: `Defect ${d.defectId} has no weighted severity under DSI ${formula.version}` };
    }
    weighted += w;
    count += 1;
  }
  return { weighted, count };
}

export function addDsiParts(a: DsiParts, b: DsiParts): DsiParts {
  const out: DsiParts = { weighted: a.weighted + b.weighted, count: a.count + b.count };
  const error = a.error ?? b.error;
  if (error) out.error = error;
  return out;
}

/** Unrounded DSI; `decimals` applies only at presentation. Zero denominator → N/A (null). */
export function dsiValue(formula: DsiFormula | null, parts: DsiParts, totalTc: number): DsiValue {
  if (!formula) return DSI_UNAVAILABLE;
  if (parts.error) return { status: 'unavailable', reason: parts.error };
  const denom = formula.denominator === 'none' ? 1 : formula.denominator === 'totalTc' ? totalTc : parts.count;
  return { status: 'ok', value: denom === 0 ? null : parts.weighted / denom, formulaVersion: formula.version };
}

/** Convenience for a defect list. */
export function computeDsi(formula: DsiFormula | null, defects: DefectRecord[], totalTc: number): DsiValue {
  return dsiValue(formula, dsiParts(formula, defects), totalTc);
}
