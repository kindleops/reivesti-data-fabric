import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalJson, contentDigest, deterministicId, sha256 } from '../src/core/hash.ts';
import { isFabricError } from '../src/core/errors.ts';
import { childNamed, childrenNamed, parseXml } from '../src/core/xml.ts';
import { crc32, isZip, readZip } from '../src/core/zip.ts';
import { FIXTURES, fixtureXml, tempRoot } from './helpers.ts';

// --- content identity --------------------------------------------------------

test('canonical JSON is key-order independent, so digests are stable', () => {
  const a = { b: 1, a: { d: [1, 2], c: 'x' } };
  const b = { a: { c: 'x', d: [1, 2] }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(contentDigest(a), contentDigest(b));
});

test('canonical JSON treats an absent key and an undefined value identically', () => {
  assert.equal(canonicalJson({ a: 1 }), canonicalJson({ a: 1, b: undefined }));
});

test('canonical JSON refuses values it cannot round-trip honestly', () => {
  assert.throws(() => canonicalJson({ x: Number.NaN }), TypeError);
  assert.throws(() => canonicalJson({ x: 1n }), TypeError);
});

test('deterministic ids cannot collide across differently split parts', () => {
  assert.notEqual(deterministicId('ns', 'a', 'bc'), deterministicId('ns', 'ab', 'c'));
  assert.equal(deterministicId('ns', 'a', 'bc'), deterministicId('ns', 'a', 'bc'));
  assert.notEqual(deterministicId('one', 'a'), deterministicId('two', 'a'));
});

// --- XML strictness ----------------------------------------------------------

test('XML reader preserves repeated siblings rather than collapsing them', () => {
  const root = parseXml('<r><a>1</a><a>2</a><a>3</a></r>');
  assert.deepEqual(childrenNamed(root, 'a').map((c) => c.text), ['1', '2', '3']);
});

test('XML reader decodes only the five predefined entities', () => {
  assert.equal(parseXml('<r>a &amp; b &lt;c&gt; &#65;</r>').text, 'a & b <c> A');
  assert.throws(() => parseXml('<r>&nbsp;</r>'), (e: unknown) => isFabricError(e, 'PARSE'));
});

test('XML reader keeps CDATA literal', () => {
  assert.equal(parseXml('<r><![CDATA[a & <b>]]></r>').text, 'a & <b>');
});

test('XML reader rejects malformed documents loudly', () => {
  const cases = [
    '<r><a></r>',                  // mismatched close
    '<r>',                         // unclosed root
    '<r></r><s></s>',              // content after root
    '<r a=1></r>',                 // unquoted attribute
    'not xml at all',              // no root
  ];
  for (const xml of cases) {
    assert.throws(() => parseXml(xml, 'case'), (e: unknown) => isFabricError(e, 'PARSE'), xml);
  }
});

test('XML reader refuses DOCTYPE, closing off entity expansion and external entities', () => {
  const xml = fixtureXml('95-doctype-entity.xml');
  assert.throws(
    () => parseXml(xml, 'xxe'),
    (e: unknown) => isFabricError(e, 'PARSE') && /DOCTYPE/.test((e as Error).message),
  );
});

test('the malformed eCRV fixture fails to parse', () => {
  assert.throws(() => parseXml(fixtureXml('94-malformed.xml'), 'malformed'), (e: unknown) => isFabricError(e, 'PARSE'));
});

test('XML reader reports the line of the fault', () => {
  try {
    parseXml('<r>\n  <a>\n</r>', 'lines');
    assert.fail('expected a parse failure');
  } catch (e) {
    assert.match((e as Error).message, /lines:\d+/);
  }
});

// --- zip ---------------------------------------------------------------------

test('zip reader opens an archive produced by the system zip tool', () => {
  const bytes = readFileSync(join(FIXTURES, 'weekly-extract-sample.zip'));
  assert.ok(isZip(bytes));
  const entries = readZip(bytes);
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((e) => e.name).sort(),
    [
      '01-single-buyer-single-seller-mortgage.xml',
      '02-multi-party-multi-parcel-contract-for-deed.xml',
      '03-gift-no-financing-no-contact.xml',
    ],
  );
  for (const entry of entries) {
    assert.equal(crc32(entry.bytes), entry.crc32);
    assert.ok(childNamed(parseXml(new TextDecoder().decode(entry.bytes), entry.name), 'headerForm'));
  }
});

test('crc32 matches the reference check value', () => {
  // The standard CRC-32 check value for "123456789".
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('zip reader detects a corrupted entry instead of returning partial data', () => {
  const root = tempRoot('df-zip-');
  const original = readFileSync(join(FIXTURES, 'weekly-extract-sample.zip'));
  // Every offset inside a compressed payload must be caught, whether by the
  // inflate step, the length check or the CRC check.
  for (const offset of [200, 400, 1000]) {
    const corrupted = Buffer.from(original);
    corrupted[offset] = (corrupted[offset] as number) ^ 0xff;
    const path = join(root, `corrupt-${offset}.zip`);
    writeFileSync(path, corrupted);
    assert.throws(
      () => readZip(readFileSync(path)),
      (e: unknown) => isFabricError(e, 'PARSE'),
      `corruption at offset ${offset} was not detected`,
    );
  }
});

test('zip reader rejects bytes that are not an archive', () => {
  assert.equal(isZip(new TextEncoder().encode('<xml/>')), false);
  assert.throws(() => readZip(new TextEncoder().encode('nope')), (e: unknown) => isFabricError(e, 'PARSE'));
});

test('stored (uncompressed) zip entries are supported as well as deflated ones', () => {
  const root = tempRoot('df-zip0-');
  writeFileSync(join(root, 'a.xml'), '<r>stored</r>');
  execFileSync('zip', ['-q', '-X', '-0', 'stored.zip', 'a.xml'], { cwd: root });
  const entries = readZip(readFileSync(join(root, 'stored.zip')));
  assert.equal(entries.length, 1);
  assert.equal(new TextDecoder().decode((entries[0] as { bytes: Uint8Array }).bytes), '<r>stored</r>');
});

test('sha256 matches the digest of the pinned schema recorded in the connector', () => {
  const source = readFileSync(join(FIXTURES, 'schema', 'sales-extract-schema-3.xsd'), 'utf8');
  assert.equal(sha256(source), '2bf2edb3094abc7ce0805f1497978646efda6fab929d1aa7a395f7efe483e820');
});
