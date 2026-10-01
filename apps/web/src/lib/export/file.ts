/**
 * The shape of an export, before it is a CSV or a JSON document.
 *
 * An export is a list of tables, each with its own column header, and free text
 * between them. Saying so explicitly is the whole point of this type: the first
 * version of this code inferred which row was the header by counting filled
 * cells, and it inferred wrong — the provenance line `Period, 2025-06-01, to,
 * 2025-06-30` fills four cells, so every export keyed its data off the word
 * "Period". A format that has to be guessed at is a format that will be guessed
 * at wrongly, so the builders declare it.
 *
 * Both writers consume this one structure, which is what keeps the CSV and the
 * JSON of a figure identical.
 */
import type { CsvCell } from './csv';

export interface ExportTable {
  /** Free text above this table, for a caption or a caveat. */
  notes?: string[];
  /** Column names. A table with no header is just rows of labelled pairs. */
  header?: CsvCell[];
  rows: CsvCell[][];
}

export interface ExportFile {
  /** Without an extension; the route adds one. */
  filename: string;
  title: string;
  /** Period, preparation time and the disclaimer. Always present. */
  notes: string[];
  tables: ExportTable[];
}
