/**
 * Strict, deterministic, dependency-free XML reader for source documents.
 *
 * Deliberate properties:
 *  - Malformed input fails loudly (FabricError PARSE). Nothing is repaired.
 *  - DOCTYPE / internal entity declarations are refused outright, which removes
 *    the XXE and entity-expansion classes from every connector at once.
 *  - Document order and repetition are preserved. Repeated siblings are never
 *    collapsed, because "one buyer" and "three buyers" must stay distinguishable.
 *  - No coercion. Everything is text until a typed reader asks for a type.
 */
import { fail } from './errors.ts';

export type XmlElement = {
  /** Qualified name exactly as written, e.g. "xs:element". */
  readonly name: string;
  /** Name with any namespace prefix removed, e.g. "element". */
  readonly localName: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  /** Concatenated direct character data (entity-decoded), excluding descendants. */
  readonly text: string;
  /** 1-based line of the opening tag, for diagnostics. */
  readonly line: number;
};

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[A-Za-z0-9_:.\-]/;

export function parseXml(source: string, origin = '<memory>'): XmlElement {
  return new XmlReader(source, origin).document();
}

class XmlReader {
  private i = 0;
  private readonly s: string;
  private readonly origin: string;

  constructor(source: string, origin: string) {
    this.s = source;
    this.origin = origin;
  }

  private lineAt(pos: number): number {
    let line = 1;
    for (let k = 0; k < pos && k < this.s.length; k++) if (this.s.charCodeAt(k) === 10) line++;
    return line;
  }

  private bad(message: string): never {
    return fail('PARSE', `${this.origin}:${this.lineAt(this.i)}: ${message}`, {
      origin: this.origin,
      line: this.lineAt(this.i),
      offset: this.i,
    });
  }

  private startsWith(token: string): boolean {
    return this.s.startsWith(token, this.i);
  }

  private skipSpace(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i] as string)) this.i++;
  }

  /** Consumes prologue noise (declaration, comments, PIs) and refuses DOCTYPE. */
  private skipProlog(): void {
    for (;;) {
      this.skipSpace();
      if (this.startsWith('<?')) {
        const end = this.s.indexOf('?>', this.i);
        if (end < 0) this.bad('unterminated processing instruction');
        this.i = end + 2;
        continue;
      }
      if (this.startsWith('<!--')) {
        const end = this.s.indexOf('-->', this.i);
        if (end < 0) this.bad('unterminated comment');
        this.i = end + 3;
        continue;
      }
      if (this.startsWith('<!DOCTYPE')) {
        this.bad('DOCTYPE declarations are refused: entity expansion and external entities are not permitted in source documents');
      }
      return;
    }
  }

  document(): XmlElement {
    this.skipProlog();
    if (!this.startsWith('<')) this.bad('expected a root element');
    const root = this.element();
    this.skipProlog();
    if (this.i < this.s.length) this.bad('unexpected content after the root element');
    return root;
  }

  private name(): string {
    const start = this.i;
    if (this.i >= this.s.length || !NAME_START.test(this.s[this.i] as string)) this.bad('expected an element or attribute name');
    this.i++;
    while (this.i < this.s.length && NAME_CHAR.test(this.s[this.i] as string)) this.i++;
    return this.s.slice(start, this.i);
  }

  private element(): XmlElement {
    const line = this.lineAt(this.i);
    if (this.s[this.i] !== '<') this.bad('expected "<"');
    this.i++;
    const name = this.name();

    const attrs: Record<string, string> = {};
    for (;;) {
      this.skipSpace();
      if (this.startsWith('/>')) {
        this.i += 2;
        return { name, localName: localOf(name), attrs, children: [], text: '', line };
      }
      if (this.startsWith('>')) {
        this.i += 1;
        break;
      }
      const attrName = this.name();
      if (attrName in attrs) this.bad(`duplicate attribute "${attrName}" on <${name}>`);
      this.skipSpace();
      if (this.s[this.i] !== '=') this.bad(`attribute "${attrName}" is missing a value`);
      this.i++;
      this.skipSpace();
      const quote = this.s[this.i];
      if (quote !== '"' && quote !== "'") this.bad(`attribute "${attrName}" value must be quoted`);
      this.i++;
      const end = this.s.indexOf(quote, this.i);
      if (end < 0) this.bad(`unterminated value for attribute "${attrName}"`);
      attrs[attrName] = decodeEntities(this.s.slice(this.i, end), (m) => this.bad(m));
      this.i = end + 1;
    }

    const children: XmlElement[] = [];
    let text = '';

    for (;;) {
      if (this.i >= this.s.length) this.bad(`unclosed element <${name}>`);

      if (this.startsWith('</')) {
        this.i += 2;
        const closing = this.name();
        if (closing !== name) this.bad(`closing tag </${closing}> does not match <${name}>`);
        this.skipSpace();
        if (this.s[this.i] !== '>') this.bad(`malformed closing tag for <${name}>`);
        this.i++;
        return { name, localName: localOf(name), attrs, children, text, line };
      }

      if (this.startsWith('<!--')) {
        const end = this.s.indexOf('-->', this.i);
        if (end < 0) this.bad('unterminated comment');
        this.i = end + 3;
        continue;
      }

      if (this.startsWith('<![CDATA[')) {
        const end = this.s.indexOf(']]>', this.i);
        if (end < 0) this.bad('unterminated CDATA section');
        text += this.s.slice(this.i + 9, end); // CDATA is literal: no entity decoding
        this.i = end + 3;
        continue;
      }

      if (this.startsWith('<?')) {
        const end = this.s.indexOf('?>', this.i);
        if (end < 0) this.bad('unterminated processing instruction');
        this.i = end + 2;
        continue;
      }

      if (this.startsWith('<!')) this.bad('declarations are not permitted inside an element');

      if (this.s[this.i] === '<') {
        children.push(this.element());
        continue;
      }

      const next = this.s.indexOf('<', this.i);
      const stop = next < 0 ? this.s.length : next;
      text += decodeEntities(this.s.slice(this.i, stop), (m) => this.bad(m));
      this.i = stop;
    }
  }
}

function localOf(qualified: string): string {
  const colon = qualified.indexOf(':');
  return colon < 0 ? qualified : qualified.slice(colon + 1);
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(raw: string, onError: (message: string) => never): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return codePoint(parseInt(body.slice(2), 16), whole, onError);
    if (body.startsWith('#')) return codePoint(parseInt(body.slice(1), 10), whole, onError);
    const named = NAMED[body];
    if (named === undefined) onError(`unknown entity reference ${whole}; only the five predefined XML entities are accepted`);
    return named as string;
  });
}

function codePoint(value: number, whole: string, onError: (message: string) => never): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) onError(`invalid character reference ${whole}`);
  return String.fromCodePoint(value);
}

// ---------------------------------------------------------------------------
// Read helpers. Kept separate from the reader so that traversal never mutates.
// ---------------------------------------------------------------------------

export function childrenNamed(el: XmlElement, localName: string): readonly XmlElement[] {
  return el.children.filter((c) => c.localName === localName);
}

export function childNamed(el: XmlElement, localName: string): XmlElement | undefined {
  return el.children.find((c) => c.localName === localName);
}

/** Direct text of a named child, or undefined when the element is absent. */
export function childText(el: XmlElement, localName: string): string | undefined {
  return childNamed(el, localName)?.text;
}

/** Every distinct child element name, in first-appearance order. */
export function childNames(el: XmlElement): readonly string[] {
  const seen = new Set<string>();
  for (const c of el.children) seen.add(c.localName);
  return [...seen];
}
