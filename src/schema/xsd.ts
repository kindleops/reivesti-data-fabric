/**
 * A small XSD compiler and instance validator.
 *
 * Why compile the real XSD instead of hand-transcribing its rules: the pinned
 * schema file is retained source evidence like any other artifact, and the
 * validator is derived from it mechanically. A hand-written validator can drift
 * from the authority; a derived one cannot. The compiled model is also digested
 * (see `schemaDigest`), which turns "the publisher changed the schema" into a
 * one-line comparison instead of a code review.
 *
 * Supported subset — exactly what public-record schemas in scope actually use:
 *   xs:schema, xs:element (named, ref, inline or named type, minOccurs/maxOccurs),
 *   xs:complexType, xs:sequence, xs:simpleType, xs:restriction, xs:enumeration.
 * Anything outside the subset is refused at compile time rather than ignored.
 */
import { fail } from '../core/errors.ts';
import { canonicalJson, sha256 } from '../core/hash.ts';
import { childrenNamed, parseXml, type XmlElement } from '../core/xml.ts';

export type Occurs = number | 'unbounded';

export type XsdType =
  /** Declared with neither a type nor a content model: unconstrained content. */
  | { readonly kind: 'any' }
  | { readonly kind: 'simple'; readonly base: string; readonly enums?: readonly string[] }
  | { readonly kind: 'complex'; readonly sequence: readonly XsdParticle[] };

export type XsdParticle = {
  readonly name: string;
  readonly minOccurs: number;
  readonly maxOccurs: Occurs;
  readonly type: XsdType;
};

export type XsdModel = {
  readonly rootName: string;
  readonly rootType: XsdType;
  /** sha256 of the source XSD bytes as retrieved from the publisher. */
  readonly sourceSha256: string;
  readonly origin: string;
};

const SUPPORTED_ELEMENT_CHILDREN = new Set(['complexType', 'simpleType', 'annotation']);

export function compileXsd(source: string, origin = '<xsd>'): XsdModel {
  const doc = parseXml(source, origin);
  if (doc.localName !== 'schema') fail('CONFIG', `${origin}: expected <xs:schema> root, found <${doc.name}>`);

  const globals = new Map<string, XmlElement>();
  for (const el of childrenNamed(doc, 'element')) {
    const name = el.attrs['name'];
    if (!name) fail('CONFIG', `${origin}: a global <xs:element> is missing its name attribute`);
    if (globals.has(name)) fail('CONFIG', `${origin}: duplicate global element "${name}"`);
    globals.set(name, el);
  }
  if (globals.size === 0) fail('CONFIG', `${origin}: schema declares no global elements`);

  // The root is the first global element that no other declaration references.
  const referenced = new Set<string>();
  const collectRefs = (el: XmlElement): void => {
    for (const c of el.children) {
      const ref = c.attrs['ref'];
      if (c.localName === 'element' && ref) referenced.add(ref);
      collectRefs(c);
    }
  };
  collectRefs(doc);

  const roots = [...globals.keys()].filter((n) => !referenced.has(n));
  const rootName = roots[0];
  if (rootName === undefined) fail('CONFIG', `${origin}: every global element is referenced; cannot determine a root`);
  if (roots.length > 1) {
    fail('CONFIG', `${origin}: ambiguous root; ${roots.length} unreferenced global elements: ${roots.join(', ')}`);
  }

  const compiling = new Set<string>();

  function typeOfElement(el: XmlElement, path: string): XsdType {
    const typeAttr = el.attrs['type'];
    const complex = childrenNamed(el, 'complexType')[0];
    const simple = childrenNamed(el, 'simpleType')[0];

    for (const c of el.children) {
      if (!SUPPORTED_ELEMENT_CHILDREN.has(c.localName)) {
        fail('CONFIG', `${origin}: unsupported <xs:${c.localName}> inside element at ${path}`);
      }
    }
    if (typeAttr && (complex || simple)) {
      fail('CONFIG', `${origin}: element at ${path} declares both a type attribute and an inline type`);
    }
    if (typeAttr) return { kind: 'simple', base: typeAttr };
    if (simple) return compileSimple(simple, path);
    if (complex) return compileComplex(complex, path);
    return { kind: 'any' };
  }

  function compileSimple(simple: XmlElement, path: string): XsdType {
    const restriction = childrenNamed(simple, 'restriction')[0];
    if (!restriction) fail('CONFIG', `${origin}: <xs:simpleType> at ${path} has no <xs:restriction>`);
    const base = restriction.attrs['base'];
    if (!base) fail('CONFIG', `${origin}: <xs:restriction> at ${path} has no base`);
    const enums = childrenNamed(restriction, 'enumeration').map((e) => {
      const v = e.attrs['value'];
      if (v === undefined) fail('CONFIG', `${origin}: <xs:enumeration> at ${path} has no value`);
      return v;
    });
    return enums.length > 0 ? { kind: 'simple', base, enums } : { kind: 'simple', base };
  }

  function compileComplex(complex: XmlElement, path: string): XsdType {
    const sequence = childrenNamed(complex, 'sequence')[0];
    if (!sequence) {
      // A complexType with no sequence constrains nothing we model.
      return { kind: 'complex', sequence: [] };
    }
    for (const c of sequence.children) {
      if (c.localName !== 'element') {
        fail('CONFIG', `${origin}: unsupported particle <xs:${c.localName}> in sequence at ${path}`);
      }
    }
    const particles = sequence.children.map((c) => compileParticle(c, path));
    return { kind: 'complex', sequence: particles };
  }

  function compileParticle(el: XmlElement, parentPath: string): XsdParticle {
    const ref = el.attrs['ref'];
    const name = ref ?? el.attrs['name'];
    if (!name) fail('CONFIG', `${origin}: particle in ${parentPath} has neither name nor ref`);
    const path = `${parentPath}/${name}`;

    let type: XsdType;
    if (ref) {
      const target = globals.get(ref);
      if (!target) fail('CONFIG', `${origin}: element ref "${ref}" at ${path} does not resolve`);
      if (compiling.has(ref)) fail('CONFIG', `${origin}: recursive element reference "${ref}" at ${path}`);
      compiling.add(ref);
      type = typeOfElement(target, `#${ref}`);
      compiling.delete(ref);
    } else {
      type = typeOfElement(el, path);
    }

    return {
      name,
      minOccurs: readOccurs(el.attrs['minOccurs'], 1, path, 'minOccurs') as number,
      maxOccurs: readOccurs(el.attrs['maxOccurs'], 1, path, 'maxOccurs'),
      type,
    };
  }

  function readOccurs(raw: string | undefined, fallback: number, path: string, which: string): Occurs {
    if (raw === undefined) return fallback;
    if (raw === 'unbounded') {
      if (which === 'minOccurs') fail('CONFIG', `${origin}: minOccurs cannot be unbounded at ${path}`);
      return 'unbounded';
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) fail('CONFIG', `${origin}: invalid ${which}="${raw}" at ${path}`);
    return n;
  }

  const rootEl = globals.get(rootName) as XmlElement;
  return {
    rootName,
    rootType: typeOfElement(rootEl, `/${rootName}`),
    sourceSha256: sha256(source),
    origin,
  };
}

/**
 * Stable digest of the compiled structure. Changes when the publisher adds,
 * removes, retypes or re-enumerates anything — the tripwire behind schema-drift
 * refusal. Independent of XSD whitespace, comments and editor metadata, so a
 * cosmetic republish does not quarantine a run.
 */
export function schemaDigest(model: XsdModel): string {
  return sha256(canonicalJson({ root: model.rootName, type: model.rootType }));
}

// ---------------------------------------------------------------------------
// Instance validation
// ---------------------------------------------------------------------------

export type ValidationCode =
  | 'wrong_root'
  | 'unknown_element'
  | 'missing_element'
  | 'cardinality'
  | 'out_of_order'
  | 'enum_violation'
  | 'type_violation';

export type ValidationIssue = {
  readonly code: ValidationCode;
  readonly path: string;
  readonly message: string;
  readonly value?: string;
};

export type ValidateOptions = {
  /** xs:sequence is ordered; relaxing this downgrades order to a warning-free skip. */
  readonly enforceOrder?: boolean;
};

export function validateInstance(
  root: XmlElement,
  model: XsdModel,
  options: ValidateOptions = {},
): readonly ValidationIssue[] {
  const enforceOrder = options.enforceOrder ?? true;
  const issues: ValidationIssue[] = [];

  if (root.localName !== model.rootName) {
    issues.push({
      code: 'wrong_root',
      path: `/${root.localName}`,
      message: `expected root <${model.rootName}>, found <${root.localName}>`,
    });
    return issues;
  }

  walk(root, model.rootType, `/${model.rootName}`);
  return issues;

  function walk(el: XmlElement, type: XsdType, path: string): void {
    if (type.kind === 'any') return; // unconstrained by the authority; nothing to assert
    if (type.kind === 'simple') {
      checkSimple(el.text, type, path);
      if (el.children.length > 0) {
        for (const c of el.children) {
          issues.push({
            code: 'unknown_element',
            path: `${path}/${c.localName}`,
            message: `<${c.localName}> appears inside simple-typed <${el.localName}>`,
          });
        }
      }
      return;
    }

    const allowed = new Map(type.sequence.map((p) => [p.name, p] as const));
    const order = type.sequence.map((p) => p.name);
    const counts = new Map<string, number>();

    let cursor = -1;
    for (const child of el.children) {
      const particle = allowed.get(child.localName);
      if (!particle) {
        issues.push({
          code: 'unknown_element',
          path: `${path}/${child.localName}`,
          message: `<${child.localName}> is not declared by the pinned schema`,
        });
        continue;
      }
      counts.set(child.localName, (counts.get(child.localName) ?? 0) + 1);

      if (enforceOrder) {
        const position = order.indexOf(child.localName);
        if (position < cursor) {
          issues.push({
            code: 'out_of_order',
            path: `${path}/${child.localName}`,
            message: `<${child.localName}> appears after <${order[cursor]}>; xs:sequence requires declared order`,
          });
        } else {
          cursor = position;
        }
      }

      const n = counts.get(child.localName) as number;
      walk(child, particle.type, `${path}/${child.localName}[${n}]`);
    }

    for (const particle of type.sequence) {
      const n = counts.get(particle.name) ?? 0;
      if (n < particle.minOccurs) {
        issues.push({
          code: n === 0 ? 'missing_element' : 'cardinality',
          path: `${path}/${particle.name}`,
          message: `expected at least ${particle.minOccurs} <${particle.name}>, found ${n}`,
        });
      }
      if (particle.maxOccurs !== 'unbounded' && n > particle.maxOccurs) {
        issues.push({
          code: 'cardinality',
          path: `${path}/${particle.name}`,
          message: `expected at most ${particle.maxOccurs} <${particle.name}>, found ${n}`,
        });
      }
    }
  }

  function checkSimple(raw: string, type: Extract<XsdType, { kind: 'simple' }>, path: string): void {
    const value = raw.trim();
    if (type.enums && value !== '' && !type.enums.includes(value)) {
      issues.push({
        code: 'enum_violation',
        path,
        message: `"${value}" is not one of the ${type.enums.length} values the schema permits`,
        value,
      });
      return;
    }
    if (value === '') return; // empty element: absence of a value, not a type error
    const problem = builtinProblem(type.base, value);
    if (problem) issues.push({ code: 'type_violation', path, message: problem, value });
  }
}

const INTEGRAL = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
const DOUBLE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const DATETIME = /^-?\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
const DATE = /^-?\d{4,}-\d{2}-\d{2}(Z|[+-]\d{2}:\d{2})?$/;

const RANGE: Record<string, readonly [number, number]> = {
  'xs:byte': [-128, 127],
  'xs:short': [-32768, 32767],
  'xs:int': [-2147483648, 2147483647],
  'xs:unsignedShort': [0, 65535],
  'xs:positiveInteger': [1, Number.MAX_SAFE_INTEGER],
  'xs:nonNegativeInteger': [0, Number.MAX_SAFE_INTEGER],
};

function builtinProblem(base: string, value: string): string | null {
  switch (base) {
    case 'xs:string':
    case 'xs:normalizedString':
    case 'xs:token':
    case 'xs:anyType':
      return null;
    case 'xs:boolean':
      return ['true', 'false', '1', '0'].includes(value) ? null : `"${value}" is not an xs:boolean`;
    case 'xs:decimal':
      return DECIMAL.test(value) ? null : `"${value}" is not an xs:decimal`;
    case 'xs:double':
    case 'xs:float':
      return DOUBLE.test(value) ? null : `"${value}" is not an ${base}`;
    case 'xs:dateTime':
      return DATETIME.test(value) ? null : `"${value}" is not an xs:dateTime`;
    case 'xs:date':
      return DATE.test(value) ? null : `"${value}" is not an xs:date`;
    default: {
      if (!INTEGRAL.test(value)) {
        // Unknown bases are not silently accepted: an unrecognised base is drift.
        if (!(base in RANGE) && base !== 'xs:integer' && base !== 'xs:long') {
          return `unsupported schema base type "${base}"`;
        }
        return `"${value}" is not an ${base}`;
      }
      const bounds = RANGE[base];
      if (bounds) {
        const n = Number(value);
        if (n < bounds[0] || n > bounds[1]) return `"${value}" is outside the range of ${base}`;
      }
      return null;
    }
  }
}

/** Every element path present in an instance, sorted. Used for drift reporting. */
export function instancePaths(root: XmlElement): readonly string[] {
  const paths = new Set<string>();
  const walk = (el: XmlElement, prefix: string): void => {
    const path = `${prefix}/${el.localName}`;
    paths.add(path);
    for (const c of el.children) walk(c, path);
  };
  walk(root, '');
  return [...paths].sort();
}
