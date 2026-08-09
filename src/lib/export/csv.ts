/**
 * Formula prefix detection for CSV injection prevention (Excel / Google Sheets).
 * Cells starting with =, +, -, @, tab, or carriage return get prepended with a single quote (').
 */
const FORMULA_PREFIX_RE = /^[=+\-@\t\r]/;

/**
 * CSV export helper — RFC 4180 quoting with CSV formula injection protection.
 * Quote every field so commas/newlines/quotes round-trip cleanly.
 */
export function toCsv(rows: string[][]): string {
  const escape = (v: string | null | undefined) => {
    let str = (v ?? '').toString();
    if (FORMULA_PREFIX_RE.test(str)) {
      str = `'${str}`;
    }
    return `"${str.replace(/"/g, '""')}"`;
  };
  return rows.map((r) => r.map(escape).join(',')).join('\n');
}

/**
 * Trigger client-side browser download for a text content string.
 */
export function downloadBlob(
  filename: string,
  content: string,
  mimeType = 'text/csv;charset=utf-8;',
) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
