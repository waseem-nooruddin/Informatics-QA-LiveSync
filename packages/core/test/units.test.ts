import { describe, expect, it } from 'vitest';
import { csvCell, formatPercent } from '../src/format.ts';
import { normId, parseDate } from '../src/normalize.ts';
import { isStale } from '../src/validate.ts';
import { slugify } from '../src/discovery.ts';

describe('normalization', () => {
  it('parses ISO, DMY, MDY and Excel serial dates', () => {
    expect(parseDate('2026-10-05', 'DMY')).toBe('2026-10-05T00:00:00.000Z');
    expect(parseDate('05/10/2026', 'DMY')).toBe('2026-10-05T00:00:00.000Z');
    expect(parseDate('10/05/2026', 'MDY')).toBe('2026-10-05T00:00:00.000Z');
    expect(parseDate(46300, 'DMY')).toBe('2026-10-05T00:00:00.000Z');
    expect(parseDate('31/02/2026', 'DMY')).toBeUndefined();
    expect(parseDate('', 'DMY')).toBeNull();
    expect(parseDate('soon', 'DMY')).toBeUndefined();
  });
  it('canonicalizes identifiers', () => expect(normId('  tc  -001 ')).toBe('TC -001'));
  it('slugs module names', () => expect(slugify('Payments & Refunds')).toBe('payments-refunds'));
});

describe('presentation', () => {
  it('formats N/A for null ratios', () => {
    expect(formatPercent(null)).toBe('N/A');
    expect(formatPercent(66.666)).toBe('66.7%');
  });
  it('guards CSV formula injection', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('plain')).toBe('plain');
  });
  it('staleness is computed from last verified time', () => {
    const now = new Date('2026-10-21T00:20:00Z');
    expect(isStale('2026-10-21T00:00:00Z', now, 15)).toBe(true);
    expect(isStale('2026-10-21T00:10:00Z', now, 15)).toBe(false);
    expect(isStale(null, now, 15)).toBe(false);
  });
});
