/**
 * Writing an {@link ExportFile} out.
 *
 * Both writers walk the same structure, so a figure cannot differ between the two
 * files: the CSV flattens it and the JSON keys it, but neither recomputes
 * anything and neither decides for itself what a row means.
 */
import { cellText, formatCell, toCsv, type CsvCell } from './csv';
import type { ExportFile } from './file';

/** The flat rows a CSV is made of, header lines and blank spacers included. */
export function flatten(file: ExportFile): CsvCell[][] {
  const rows: CsvCell[][] = [[file.title], ...file.notes.map((note) => [note]), []];

  file.tables.forEach((table, i) => {
    if (i > 0) rows.push([]);
    for (const note of table.notes ?? []) rows.push([note]);
    if (table.header) rows.push([...table.header]);
    for (const row of table.rows) rows.push([...row]);
  });

  return rows;
}

export function toCsvFile(file: ExportFile): string {
  return toCsv(flatten(file));
}

export interface KeyedTable {
  notes: string[];
  columns: string[];
  rows: Record<string, string>[];
}

export interface KeyedExport {
  export: string;
  title: string;
  notes: string[];
  tables: KeyedTable[];
}

/**
 * The keyed form.
 *
 * A row longer than its header would lose its last cells to no key at all, so the
 * surplus is kept under `column8`, `column9` and so on. Nothing an export carries
 * is allowed to disappear on the way out — a figure silently missing from a file
 * is worse than one in an awkward place, because nobody goes looking for it.
 */
export function toKeyed(file: ExportFile): KeyedExport {
  return {
    export: file.filename,
    title: file.title,
    notes: [...file.notes],
    tables: file.tables.map((table) => {
      const columns = (table.header ?? []).map((c, i) => {
        const name = cellText(c);
        return name === '' ? `column${i + 1}` : name;
      });

      return {
        notes: [...(table.notes ?? [])],
        columns,
        rows: table.rows.map((row) => {
          const obj: Record<string, string> = {};
          row.forEach((cell, i) => {
            obj[columns[i] ?? `column${i + 1}`] = cellText(cell);
          });
          return obj;
        }),
      };
    }),
  };
}

/** Every cell of an export as plain text, for assertions and for searching. */
export function allCells(file: ExportFile): string[] {
  return [
    file.title,
    ...file.notes,
    ...file.tables.flatMap((t) => [
      ...(t.notes ?? []),
      ...(t.header ?? []).map(cellText),
      ...t.rows.flatMap((r) => r.map(cellText)),
    ]),
  ];
}

/** Exposed for the CSV writer's own tests. */
export const escapeCell = formatCell;
