import { monthStart, monthStartFromParam } from '../domain/month.js';
import { ValidationError } from './errors.js';

/**
 * Resolve the ?month= query param to a month_start date ('YYYY-MM-01').
 * Absent = the current UTC month. Present but not a real calendar month
 * (e.g. 2026-13) = 400.
 */
export function resolveMonthStart(month?: string): string {
  if (month === undefined) return monthStart(new Date());
  const start = monthStartFromParam(month);
  if (start === null) {
    throw new ValidationError('invalid month', [
      { path: 'month', message: 'month must be YYYY-MM with a real calendar month' },
    ]);
  }
  return start;
}
