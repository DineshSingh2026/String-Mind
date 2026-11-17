/**
 * RFC 4180 CSV with spreadsheet formula-injection protection:
 * - fields containing comma, quote, CR or LF are quoted, quotes doubled
 * - string cells starting with = + - @ TAB or CR are prefixed with a single quote
 */
export function csvCell(v: unknown): string {
  if (v == null) return '';
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') s = String(v);
  else if (typeof v === 'object') s = JSON.stringify(v);
  else {
    s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  }
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n';
}
