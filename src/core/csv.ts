/**
 * Bounded-memory CSV reader.
 *
 * The Minnesota SOS bulk file is a single CSV whose *uncompressed size may
 * exceed 2.5 GB*, so it is read one row at a time on top of the streaming line
 * reader — never split, never mapped, never materialised.
 *
 * Two properties of the SOS file shape this parser:
 *
 *  - **Field values are enclosed in double quotes, and an embedded quote is
 *    doubled.** That is stated in the implementation guide, so quoting is
 *    handled properly rather than by splitting on commas.
 *  - **Rows are heterogeneous.** One file carries three record types with
 *    different column counts, distinguished by a record-type column. So the
 *    reader yields raw cell arrays and lets the caller dispatch; imposing a
 *    single header on the file would be wrong.
 *
 * A quoted field may contain newlines, so the reader cannot simply treat one
 * line as one row. It accumulates across lines while a quote is open.
 */
import { fail } from './errors.ts';
import { readLines } from './lines.ts';

export type CsvRow = {
  readonly cells: readonly string[];
  /** 1-based row number in the file, for diagnostics. */
  readonly rowNumber: number;
};

export type CsvOptions = {
  readonly delimiter?: string;
  readonly quote?: string;
  /** Rows to skip at the start, e.g. a header the caller has already read. */
  readonly skipRows?: number;
  /** Guard against a runaway unterminated quote consuming the whole file. */
  readonly maxRowChars?: number;
};

const DEFAULT_MAX_ROW_CHARS = 1 << 20; // 1 MiB — far beyond any legitimate row

/**
 * Parses one complete CSV record from text that may span several lines.
 *
 * Returns null when the record is incomplete (an open quote), so the caller can
 * append the next line and try again.
 */
export function parseCsvRecord(
  text: string,
  delimiter: string,
  quote: string,
): readonly string[] | null {
  const cells: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;

    if (inQuotes) {
      if (ch === quote) {
        // A doubled quote is a literal quote, exactly as the SOS guide states.
        if (text[i + 1] === quote) {
          cell += quote;
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === quote) {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }

  if (inQuotes) return null; // the record continues on the next line
  cells.push(cell);
  return cells;
}

/** Yields one row at a time. Memory is one row, not one file. */
export async function* readCsvRows(
  path: string,
  options: CsvOptions = {},
): AsyncGenerator<CsvRow> {
  const delimiter = options.delimiter ?? ',';
  const quote = options.quote ?? '"';
  const skipRows = options.skipRows ?? 0;
  const maxRowChars = options.maxRowChars ?? DEFAULT_MAX_ROW_CHARS;

  let pending = '';
  let rowNumber = 0;

  for await (const line of readLines(path)) {
    pending = pending === '' ? line : `${pending}\n${line}`;
    if (pending.length > maxRowChars) {
      fail('PARSE', `${path}: a CSV record exceeded ${maxRowChars} characters, which means an unterminated quote`, {
        rowNumber: rowNumber + 1,
      });
    }
    const cells = parseCsvRecord(pending, delimiter, quote);
    if (cells === null) continue; // quoted newline; keep accumulating

    pending = '';
    rowNumber += 1;
    if (rowNumber <= skipRows) continue;
    yield { cells, rowNumber };
  }

  if (pending !== '') {
    fail('PARSE', `${path}: the file ends inside a quoted field`, { rowNumber: rowNumber + 1 });
  }
}

/** Same, over an async line source. Used for zip entries and fixtures. */
export async function* readCsvFromLines(
  lines: AsyncIterable<string>,
  options: CsvOptions = {},
): AsyncGenerator<CsvRow> {
  const delimiter = options.delimiter ?? ',';
  const quote = options.quote ?? '"';
  const skipRows = options.skipRows ?? 0;
  const maxRowChars = options.maxRowChars ?? DEFAULT_MAX_ROW_CHARS;

  let pending = '';
  let rowNumber = 0;

  for await (const line of lines) {
    pending = pending === '' ? line : `${pending}\n${line}`;
    if (pending.length > maxRowChars) {
      fail('PARSE', `a CSV record exceeded ${maxRowChars} characters, which means an unterminated quote`, {
        rowNumber: rowNumber + 1,
      });
    }
    const cells = parseCsvRecord(pending, delimiter, quote);
    if (cells === null) continue;

    pending = '';
    rowNumber += 1;
    if (rowNumber <= skipRows) continue;
    yield { cells, rowNumber };
  }

  if (pending !== '') fail('PARSE', 'the input ends inside a quoted field', { rowNumber: rowNumber + 1 });
}

/** Trims a cell and maps the empty string to null, which is what absence means. */
export function cell(cells: readonly string[], index: number): string | null {
  const raw = cells[index];
  if (raw === undefined) return null;
  const value = raw.trim();
  return value === '' ? null : value;
}
