/**
 * Legal description handling.
 *
 * The governing rule is that the raw text is the record and the parse is a
 * convenience. A legal description is a legal instrument's own words about which
 * land it affects; a regex that gets it 90% right is useful for search and
 * dangerous for identity.
 *
 * So this parser:
 *   - always preserves the raw text unchanged;
 *   - reports a status and a confidence rather than pretending to certainty;
 *   - fails open to `unparsed` instead of guessing;
 *   - carries a parser version, so a future improvement is a visible change
 *     rather than a silent reinterpretation of history.
 *
 * Nothing it produces may raise a property link above `PROVISIONAL`. Matching a
 * property from a parsed description is a hypothesis, and the model has a word
 * for hypotheses.
 */
import { deterministicId } from '../core/hash.ts';
import type { SourceEvidence } from './models.ts';
import { type LegalDescriptionObservation, legalDescriptionIdOf } from './instruments.ts';

export const LEGAL_PARSER_VERSION = 'mn_legal_parser_1';

/**
 * Confidence at or above which structured components may be used for matching.
 * Below it the components are search hints and nothing more.
 */
export const MATCHABLE_CONFIDENCE = 0.9;

export type ParsedLegalComponents = {
  readonly lot: string | null;
  readonly block: string | null;
  readonly addition: string | null;
  readonly unit: string | null;
  readonly section: string | null;
  readonly township: string | null;
  readonly range: string | null;
  readonly status: 'unparsed' | 'partial' | 'structured';
  readonly confidence: number;
  /** Why the confidence is what it is, for a human reading a low score. */
  readonly notes: readonly string[];
};

const LOT = /\bLOTS?\s+([0-9]+[A-Z]?)\b/i;
const BLOCK = /\bBLO?C?K\.?\s+([0-9]+[A-Z]?)\b/i;
const UNIT = /\b(?:UNIT|APT|APARTMENT)\s+(?:NO\.?\s*)?([0-9A-Z-]+)\b/i;
const SECTION = /\bSEC(?:TION)?\.?\s+([0-9]{1,2})\b/i;
const TOWNSHIP = /\bTWP?\.?\s+([0-9]{1,3})\b/i;
const RANGE = /\bR(?:AN)?G?E?\.?\s+([0-9]{1,3})\b/i;
/** Plat/addition names: everything before ADDITION/ADDN, or after a comma-ADDN. */
const ADDITION = /\b([A-Z0-9'&.\- ]{3,60}?)\s+(?:ADDITION|ADDN|ADD)\b/i;

/**
 * Text that means "there is more than one parcel here" or "this is prose, not a
 * lot-and-block". A description containing any of these cannot be treated as
 * describing a single, cleanly-identified parcel.
 */
const MULTIPLICITY = /\bAND\s+LOTS?\b|\bTHROUGH\b|\bTHRU\b|\bEXCEPT\b|\bEXC\b|\bLESS\b|\bTOGETHER WITH\b|\bALSO\b|\bPART OF\b|\bTHAT PART\b/i;
/** Metes-and-bounds prose: precise, and hopeless for a regex to key on. */
const METES = /\bCOMMENCING\b|\bBEGINNING AT\b|\bTHENCE\b|\bDEGREES?\b|\bDEG\b|\bFEET\s+TO\b/i;

/**
 * Extracts structured components without ever claiming more than it knows.
 *
 * A description that mentions several lots, carves an exception, or runs to
 * metes and bounds is reported as `partial` at low confidence even when the
 * regexes matched — because what they matched is one fragment of a description
 * that means something more complicated.
 */
export function parseLegalDescription(raw: string): ParsedLegalComponents {
  const text = raw.trim();
  const notes: string[] = [];

  if (text === '') {
    return empty(['legal description is empty']);
  }

  const lot = first(LOT, text);
  const block = first(BLOCK, text);
  // The addition name is matched against text with the lot, block and unit
  // clauses removed. Without that, a lazy match still starts at the beginning of
  // the string and "LOT 1 BLOCK 2 SYNTHETIC ADDITION" yields an addition called
  // "LOT 1 BLOCK 2 SYNTHETIC".
  const addition = cleanAddition(first(ADDITION, stripParcelClauses(text)));
  const unit = first(UNIT, text);
  const section = first(SECTION, text);
  const township = first(TOWNSHIP, text);
  const range = first(RANGE, text);

  const found = [lot, block, addition, unit, section, township, range].filter((v) => v !== null).length;
  if (found === 0) {
    return empty(['no recognisable lot/block, unit or section-township-range structure']);
  }

  let confidence = 0;
  let status: ParsedLegalComponents['status'] = 'partial';

  // A complete lot-block-addition triple, or a complete section-township-range,
  // is the only shape worth calling structured.
  const platComplete = lot !== null && block !== null && addition !== null;
  const plssComplete = section !== null && township !== null && range !== null;

  if (platComplete || plssComplete) {
    status = 'structured';
    confidence = 0.95;
  } else {
    confidence = 0.4 + Math.min(found, 3) * 0.1;
    notes.push('an incomplete description: components are search hints, not identity');
  }

  if (METES.test(text)) {
    confidence = Math.min(confidence, 0.3);
    status = 'partial';
    notes.push('contains metes-and-bounds prose, which a component parse cannot represent');
  }
  if (MULTIPLICITY.test(text)) {
    confidence = Math.min(confidence, 0.35);
    status = 'partial';
    notes.push('describes more than one parcel, or carves out an exception');
  }
  if (text.length > 400) {
    confidence = Math.min(confidence, 0.5);
    notes.push('unusually long description; likely compound');
  }

  return { lot, block, addition, unit, section, township, range, status, confidence: round(confidence), notes };
}

/** True only when the parse is complete and unambiguous enough to match on. */
export function isMatchable(parsed: ParsedLegalComponents): boolean {
  return parsed.status === 'structured' && parsed.confidence >= MATCHABLE_CONFIDENCE;
}

/**
 * A comparison key for a confidently-parsed plat description.
 *
 * Returns null for anything not matchable, so a caller cannot accidentally key
 * on a guess: there is simply no key to use.
 */
export function platMatchKey(
  countyFips: string,
  parsed: ParsedLegalComponents,
): string | null {
  if (!isMatchable(parsed)) return null;
  if (parsed.lot === null || parsed.block === null || parsed.addition === null) return null;
  return deterministicId(
    'plat', countyFips,
    parsed.addition.toUpperCase().replace(/[^A-Z0-9]/g, ''),
    parsed.block.toUpperCase(),
    parsed.lot.toUpperCase(),
  );
}

export function legalObservationOf(
  instrumentId: string,
  sequence: number,
  raw: string,
  evidence: SourceEvidence,
): LegalDescriptionObservation {
  const parsed = parseLegalDescription(raw);
  return {
    legalDescriptionId: legalDescriptionIdOf(instrumentId, sequence, raw),
    instrumentId,
    sequence,
    raw,
    parseStatus: parsed.status,
    parserVersion: LEGAL_PARSER_VERSION,
    confidence: parsed.confidence,
    lot: parsed.lot,
    block: parsed.block,
    addition: parsed.addition,
    unit: parsed.unit,
    section: parsed.section,
    township: parsed.township,
    range: parsed.range,
    evidence,
  };
}

// ---------------------------------------------------------------------------

function empty(notes: readonly string[]): ParsedLegalComponents {
  return {
    lot: null, block: null, addition: null, unit: null, section: null, township: null, range: null,
    status: 'unparsed', confidence: 0, notes,
  };
}

function first(pattern: RegExp, text: string): string | null {
  const m = pattern.exec(text);
  return m?.[1] ? m[1].trim().toUpperCase() : null;
}

/** Removes the clauses that precede an addition name in a plat description. */
function stripParcelClauses(text: string): string {
  return text
    .replace(/\bLOTS?\s+[0-9]+[A-Z]?\b/gi, ' ')
    .replace(/\bBLO?C?K\.?\s+[0-9]+[A-Z]?\b/gi, ' ')
    .replace(/\b(?:UNIT|APT|APARTMENT)\s+(?:NO\.?\s*)?[0-9A-Z-]+\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanAddition(value: string | null): string | null {
  if (value === null) return null;
  // Strip leading connectives the pattern can pick up from surrounding prose.
  const cleaned = value.replace(/^(?:IN|OF|TO|THE)\s+/i, '').trim();
  return cleaned.length >= 3 ? cleaned : null;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
