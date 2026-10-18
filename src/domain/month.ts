/**
 * UTC calendar-month math - pure. The usage window is the UTC calendar
 * month everywhere in the service; `month_start` (the DB date column) is
 * always the first UTC day, formatted 'YYYY-MM-DD'.
 */

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** First day of the UTC month containing `date`, as 'YYYY-MM-DD'. */
export function monthStart(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-01`;
}

/**
 * 'YYYY-MM' (the ?month= query param on usage/history endpoints) to
 * 'YYYY-MM-01', or null when the param is not a valid calendar month
 * (wrong shape, or month outside 01-12).
 */
export function monthStartFromParam(month: string): string | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const year = match?.[1];
  const monthNum = Number(match?.[2]);
  if (year === undefined || match?.[2] === undefined) return null;
  if (monthNum < 1 || monthNum > 12) return null;
  return `${year}-${match[2]}-01`;
}
