import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { isFabricError } from '../src/core/errors.ts';
import { parseXml } from '../src/core/xml.ts';
import { compileXsd, instancePaths, schemaDigest, validateInstance } from '../src/schema/xsd.ts';
import { loadPinnedSchema, PINNED_SCHEMA_SHA256 } from '../src/connectors/mn-ecrv/index.ts';
import { fixture, fixtureXml, harness, tempRoot } from './helpers.ts';

const { model, digest } = loadPinnedSchema();

// --- the compiler ------------------------------------------------------------

test('the pinned schema compiles to the published eCRV structure', () => {
  assert.equal(model.rootName, 'ecrvForm');
  assert.equal(model.sourceSha256, PINNED_SCHEMA_SHA256);
  assert.equal(model.rootType.kind, 'complex');
  const names = model.rootType.kind === 'complex' ? model.rootType.sequence.map((p) => p.name) : [];
  assert.deepEqual(names, [
    'headerForm', 'buyersForm', 'sellersForm', 'propertyForm',
    'salesAgreementForm', 'supplementaryForm', 'submitterForm',
  ]);
});

test('submitterForm is unconstrained in the published schema, and is modelled as such', () => {
  // The department declares <xs:element name="submitterForm"/> with no content
  // model, so nothing about its shape is guaranteed. Pretending otherwise would
  // be inventing a contract the authority never made.
  const submitter = model.rootType.kind === 'complex'
    ? model.rootType.sequence.find((p) => p.name === 'submitterForm')
    : undefined;
  assert.equal(submitter?.type.kind, 'any');
});

test('the schema digest is stable and ignores cosmetic republishing', () => {
  const { model: again } = loadPinnedSchema();
  assert.equal(schemaDigest(again), digest);

  const source = `<?xml version="1.0"?>\n<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">\n`
    + `<xs:element name="r"><xs:complexType><xs:sequence>`
    + `<xs:element name="a" type="xs:string"/></xs:sequence></xs:complexType></xs:element></xs:schema>`;
  const withComments = source.replace('<xs:element name="r">', '<!-- edited by somebody --><xs:element name="r">');
  assert.equal(schemaDigest(compileXsd(source)), schemaDigest(compileXsd(withComments)));
});

test('the schema digest changes when the publisher changes the structure', () => {
  const base = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">`
    + `<xs:element name="r"><xs:complexType><xs:sequence>`
    + `<xs:element name="a" type="xs:string"/></xs:sequence></xs:complexType></xs:element></xs:schema>`;
  const added = base.replace('</xs:sequence>', '<xs:element name="b" type="xs:string"/></xs:sequence>');
  const retyped = base.replace('name="a" type="xs:string"', 'name="a" type="xs:int"');
  assert.notEqual(schemaDigest(compileXsd(base)), schemaDigest(compileXsd(added)));
  assert.notEqual(schemaDigest(compileXsd(base)), schemaDigest(compileXsd(retyped)));
});

test('the compiler refuses XSD constructs it does not model rather than ignoring them', () => {
  const withChoice = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">`
    + `<xs:element name="r"><xs:complexType><xs:sequence><xs:choice/></xs:sequence></xs:complexType></xs:element></xs:schema>`;
  assert.throws(() => compileXsd(withChoice), (e: unknown) => isFabricError(e, 'CONFIG'));

  const danglingRef = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">`
    + `<xs:element name="r"><xs:complexType><xs:sequence><xs:element ref="missing"/></xs:sequence></xs:complexType></xs:element></xs:schema>`;
  assert.throws(() => compileXsd(danglingRef), (e: unknown) => isFabricError(e, 'CONFIG'));
});

test('a tampered or republished schema file fails the pinned digest check', () => {
  const root = tempRoot('df-schema-');
  const path = join(root, 'tampered.xsd');
  writeFileSync(path, '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="r"/></xs:schema>');
  assert.throws(() => loadPinnedSchema(path), (e: unknown) => isFabricError(e, 'SCHEMA_DRIFT'));
});

// --- instance validation ------------------------------------------------------

test('a conforming document validates with no issues', () => {
  const root = parseXml(fixtureXml('01-single-buyer-single-seller-mortgage.xml'), 'ok');
  assert.deepEqual(validateInstance(root, model), []);
});

test('a missing required field is reported as a record fault', () => {
  const root = parseXml(fixtureXml('92-missing-required-legal-description.xml'), 'missing');
  const issues = validateInstance(root, model);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.code, 'missing_element');
  assert.match(issues[0]?.path ?? '', /legalDescription$/);
});

test('an element the schema does not declare is reported, never dropped', () => {
  const root = parseXml(fixtureXml('90-drift-unknown-element.xml'), 'unknown');
  const issues = validateInstance(root, model);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.code, 'unknown_element');
  assert.match(issues[0]?.path ?? '', /assessorMarketValue$/);
});

test('a value outside a published enumeration is reported', () => {
  const root = parseXml(fixtureXml('91-drift-enum-deed-type.xml'), 'enum');
  const issues = validateInstance(root, model);
  assert.equal(issues[0]?.code, 'enum_violation');
  assert.equal(issues[0]?.value, 'CRYPTODEED');
});

test('type violations are reported per field', () => {
  const xml = fixtureXml('01-single-buyer-single-seller-mortgage.xml')
    .replace('<totPurchaseAmt>300000.00</totPurchaseAmt>', '<totPurchaseAmt>three hundred thousand</totPurchaseAmt>');
  const issues = validateInstance(parseXml(xml, 'type'), model);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.code, 'type_violation');
});

test('an empty element is absence, not a type error', () => {
  const xml = fixtureXml('01-single-buyer-single-seller-mortgage.xml')
    .replace('<deedTypeCde>WARRNTY</deedTypeCde>', '<deedTypeCde></deedTypeCde>')
    .replace('<sellerPdPts>0</sellerPdPts>', '<sellerPdPts></sellerPdPts>');
  assert.deepEqual(validateInstance(parseXml(xml, 'empty'), model), []);
});

test('xs:sequence order is enforced, because the schema specifies it', () => {
  const xml = fixtureXml('01-single-buyer-single-seller-mortgage.xml')
    .replace(
      '    <countyCde>27</countyCde>\n    <crvNumberId>1000001</crvNumberId>',
      '    <crvNumberId>1000001</crvNumberId>\n    <countyCde>27</countyCde>',
    );
  const issues = validateInstance(parseXml(xml, 'order'), model);
  assert.ok(issues.some((i) => i.code === 'out_of_order'));
  // Relaxing the check is possible for a live feed that turns out to reorder.
  assert.deepEqual(validateInstance(parseXml(xml, 'order'), model, { enforceOrder: false }), []);
});

test('instance paths enumerate what a document actually contains', () => {
  const paths = instancePaths(parseXml(fixtureXml('01-single-buyer-single-seller-mortgage.xml'), 'paths'));
  assert.ok(paths.includes('/ecrvForm/salesAgreementForm/financeArrangements/interestRate'));
  assert.ok(paths.includes('/ecrvForm/buyersForm/individuals/daytimePhone'));
});

// --- drift quarantines the run ------------------------------------------------

test('an unknown element quarantines the whole run rather than being ignored', async () => {
  const h = harness();
  const result = await h.run([fixture('90-drift-unknown-element.xml')]);

  assert.equal(result.run.status, 'quarantined');
  assert.equal(result.run.failureKind, 'SCHEMA_DRIFT');
  assert.equal(result.run.metrics.rowsEmitted, 0);
  assert.deepEqual(result.bundles, []);
  assert.ok(result.run.unknownFields.some((f) => f.endsWith('assessorMarketValue')));
  assert.ok((result.run.failureMessage ?? '').includes('unknown_element'));
});

test('enum drift quarantines the run', async () => {
  const h = harness();
  const result = await h.run([fixture('91-drift-enum-deed-type.xml')]);
  assert.equal(result.run.status, 'quarantined');
  assert.equal(result.run.failureKind, 'SCHEMA_DRIFT');
  assert.ok((result.run.failureMessage ?? '').includes('enum_violation'));
});

test('a quarantined run still retains the evidence and records the attempt', async () => {
  const h = harness();
  const result = await h.run([fixture('90-drift-unknown-element.xml')]);
  assert.ok(result.artifact, 'the artifact must be retained even when the run is quarantined');
  const view = await h.artifactStore.view(result.artifact);
  assert.equal(view.interpretations.length, 1);
  assert.equal(view.interpretations[0]?.quarantined, true);
});

test('a single malformed record fault quarantines that record, not the run', async () => {
  const h = harness();
  const result = await h.run([
    fixture('01-single-buyer-single-seller-mortgage.xml'),
    fixture('92-missing-required-legal-description.xml'),
  ], { selectRelease: (r) => r[0] });

  // Each local release is its own artifact; the first one is chosen. Run the
  // faulty one on its own to see record-level quarantine.
  assert.equal(result.run.status, 'completed');

  const second = await harness().run([fixture('92-missing-required-legal-description.xml')]);
  assert.equal(second.run.status, 'quarantined'); // every record in the run was faulty
  assert.equal(second.run.metrics.rowsQuarantined, 1);
  assert.equal(second.run.metrics.rowsEmitted, 0);
  assert.equal(second.run.failureKind, null); // not drift: a record fault
});

test('malformed XML fails the run rather than yielding partial records', async () => {
  const h = harness();
  const result = await h.run([fixture('94-malformed.xml')]);
  assert.equal(result.run.status, 'failed');
  assert.equal(result.run.failureKind, 'PARSE');
  assert.equal(result.run.stage, 'parse');
});

test('a document with a DOCTYPE fails the run', async () => {
  const result = await harness().run([fixture('95-doctype-entity.xml')]);
  assert.equal(result.run.status, 'failed');
  assert.equal(result.run.failureKind, 'PARSE');
});

test('a county code that disagrees with itself quarantines the record', async () => {
  const result = await harness().run([fixture('93-county-mismatch.xml')]);
  assert.equal(result.run.metrics.rowsQuarantined, 1);
  assert.equal(result.run.metrics.rowsEmitted, 0);
  assert.equal(result.run.validationErrorCount, 1);
});
