/**
 * CSV export helper — RFC 4180 quoting. Quote every field so
 * commas/newlines/quotes round-trip cleanly.
 */
export function toCsv(rows: string[][]): string {
  const escape = (v: string | null | undefined) =>
    `"${(v ?? "").toString().replace(/"/g, '""')}"`;
  return rows.map((r) => r.map(escape).join(",")).join("\n");
}

/**
 * Trigger client-side browser download for a text content string.
 */
export function downloadBlob(
  filename: string,
  content: string,
  mimeType = "text/csv;charset=utf-8;",
) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
