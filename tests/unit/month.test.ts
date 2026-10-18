import { describe, expect, it } from 'vitest';
import { monthStart, monthStartFromParam } from '../../src/domain/month.js';

// The UTC boundary test the plan calls out: Oct 31 23:59:59.999Z is still
// October; one millisecond later it is November. These must stay green forever.
describe('monthStart (UTC calendar months)', () => {
  it('returns the first day of the current UTC month', () => {
    expect(monthStart(new Date('2026-10-18T12:00:00.000Z'))).toBe('2026-10-01');
  });

  it('treats the last instant of a month as that month', () => {
    expect(monthStart(new Date('2026-10-31T23:59:59.999Z'))).toBe('2026-10-01');
  });

  it('rolls over exactly at the UTC month boundary', () => {
    expect(monthStart(new Date('2026-11-01T00:00:00.000Z'))).toBe('2026-11-01');
  });

  it('handles year boundaries', () => {
    expect(monthStart(new Date('2026-12-31T23:59:59.999Z'))).toBe('2026-12-01');
    expect(monthStart(new Date('2027-01-01T00:00:00.000Z'))).toBe('2027-01-01');
  });

  it('pads single-digit months', () => {
    expect(monthStart(new Date('2026-01-09T00:00:00.000Z'))).toBe('2026-01-01');
  });
});

describe('monthStartFromParam', () => {
  it('converts YYYY-MM to the month-start date', () => {
    expect(monthStartFromParam('2026-10')).toBe('2026-10-01');
    expect(monthStartFromParam('2026-01')).toBe('2026-01-01');
    expect(monthStartFromParam('1999-12')).toBe('1999-12-01');
  });

  it('rejects malformed or out-of-range params', () => {
    expect(monthStartFromParam('2026-13')).toBeNull();
    expect(monthStartFromParam('2026-00')).toBeNull();
    expect(monthStartFromParam('202610')).toBeNull();
    expect(monthStartFromParam('2026/10')).toBeNull();
    expect(monthStartFromParam('')).toBeNull();
  });
});
