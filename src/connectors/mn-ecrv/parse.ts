/**
 * Deterministic eCRV reader.
 *
 * Explicit about every coercion, because implicit coercion is how a public
 * record quietly becomes a different fact:
 *
 *   currency  parsed as exact integer minor units via string arithmetic. No
 *             floating point ever touches a purchase price.
 *   dateTime  a value with no timezone offset is a wall-clock statement by the
 *             submitter, so it is preserved verbatim rather than shifted into
 *             UTC — which is how a 1 January sale becomes a 31 December sale.
 *   boolean   only the four lexical forms XSD permits. Anything else is a
 *             validation issue, not a false.
 *   empty     an empty element is absence, and absence is null. It is never zero.
 */
import { fail } from '../../core/errors.ts';
import { childNamed, childrenNamed, parseXml, type XmlElement } from '../../core/xml.ts';
import { isZip, readZip } from '../../core/zip.ts';
import type {
  EcrvAddress,
  EcrvFinanceArrangement,
  EcrvParcel,
  EcrvParty,
  EcrvPersonalProperty,
  EcrvPropertyProgram,
  EcrvRecord,
  EcrvUse,
} from './record.ts';

export type EcrvDocument = { readonly name: string; readonly xml: string };

/** Splits an artifact into its constituent eCRV documents, in archive order. */
export function splitArtifact(bytes: Uint8Array): readonly EcrvDocument[] {
  if (isZip(bytes)) {
    return readZip(bytes)
      .filter((e) => e.name.toLowerCase().endsWith('.xml'))
      .map((e) => ({ name: e.name, xml: new TextDecoder('utf-8').decode(e.bytes) }));
  }
  const text = new TextDecoder('utf-8').decode(bytes);
  if (!text.trimStart().startsWith('<')) {
    fail('PARSE', 'artifact is neither a zip archive nor an XML document');
  }
  return [{ name: 'source-original.xml', xml: text }];
}

export type ParsedDocument = {
  readonly root: XmlElement;
  readonly record: EcrvRecord;
  readonly sourceRecordId: string;
};

/** Source record identity: the publisher's own key, county-scoped. */
export function ecrvSourceRecordId(countyCode: string, crvNumber: string): string {
  return `MN-${countyCode}-${crvNumber}`;
}

export function parseEcrvDocument(xml: string, origin: string): ParsedDocument {
  const root = parseXml(xml, origin);
  if (root.localName !== 'ecrvForm') {
    fail('PARSE', `${origin}: expected <ecrvForm> root, found <${root.localName}>`);
  }

  const header = section(root, 'headerForm', origin);
  const countyCode = normalizeCountyCode(text(header, 'countyCde'));
  const crvNumber = text(header, 'crvNumberId');
  if (!countyCode || !crvNumber) {
    fail('PARSE', `${origin}: eCRV document has no county code or CRV number, so it has no identity`);
  }

  const propertyForm = section(root, 'propertyForm', origin);
  const salesForm = section(root, 'salesAgreementForm', origin);
  const supplementary = section(root, 'supplementaryForm', origin);
  const buyersForm = childNamed(root, 'buyersForm');
  const sellersForm = childNamed(root, 'sellersForm');

  const buyers = buyersForm ? readParties(buyersForm, 'buyer', origin) : [];
  const sellers = sellersForm ? readParties(sellersForm, 'seller', origin) : [];

  const submitterForm = childNamed(root, 'submitterForm');

  const record: EcrvRecord = {
    countyCode,
    crvNumber,
    property: {
      countyCode: optional(normalizeCountyCode(text(propertyForm, 'county'))),
      legalDescription: optional(text(propertyForm, 'legalDescription')),
      parcels: childrenNamed(propertyForm, 'parcels').map(readParcel(origin)),
      addresses: childrenNamed(propertyForm, 'mnPropertyAddresses').map(readAddress),
      plannedUses: childrenNamed(propertyForm, 'plannedUses').map(readUse(origin)),
      usesBeforeSale: childrenNamed(propertyForm, 'usesBeforeSale').map(readUse(origin)),
      programs: childrenNamed(propertyForm, 'propertyPrograms').map(readProgram),
      totalAcres: optional(text(propertyForm, 'totalAcres')),
      tillableAcres: optional(text(propertyForm, 'tillableAcres')),
      irrigatedAcres: optional(text(propertyForm, 'irrigatedAcres')),
      principalResidence: bool(propertyForm, 'principalResidence', origin),
      newBuildingsOnSaleYear: bool(propertyForm, 'newBuildingsOnSaleYear', origin),
      numberOfRentalBuildings: int(propertyForm, 'numberOfRentalBuildings', origin),
      numberOfRentalUnitsInAllBuildings: int(propertyForm, 'numberOfRentalUnitsInAllBuildings', origin),
      whatIsIncludedInSaleCode: optional(text(propertyForm, 'whatIsIncludedInSale')),
    },
    buyers,
    sellers,
    sale: {
      deedContractDate: dateTime(salesForm, 'deedContractDate', origin),
      deedTypeCode: optional(text(salesForm, 'deedTypeCde')),
      totalPurchaseAmountMinor: money(salesForm, 'totPurchaseAmt', origin),
      downPaymentEquityMinor: money(salesForm, 'downPmtEquity', origin),
      sellerPaidPointsMinor: money(salesForm, 'sellerPdPts', origin),
      specialAssessmentAmountMinor: money(salesForm, 'specialAssesmtAmt', origin),
      personalPropertyIncludedInTotal: bool(salesForm, 'personalPropertyIncludedInTotal', origin),
      financeTypeCode: optional(text(salesForm, 'financeType')),
      financeArrangements: childrenNamed(salesForm, 'financeArrangements').map(readFinance(origin)),
      personalProperties: childrenNamed(salesForm, 'personalProperties').map(readPersonalProperty(origin)),
      agreement2YrsOld: bool(salesForm, 'agreement2YrsOld', origin),
      buyerPartInterest: bool(salesForm, 'buyerPartInterest', origin),
      deedPayoff: bool(salesForm, 'deedPayoff', origin),
      didBuyerLease: bool(salesForm, 'didBuyerLease', origin),
      didSellerLease: bool(salesForm, 'didSellerLease', origin),
      sellerLeaseMonths: int(salesForm, 'sellerLeaseMonths', origin),
      guaranteeRentIncome: bool(salesForm, 'guaranteeRentIncome', origin),
      leaseOptionToBuy: bool(salesForm, 'leaseOptionToBuy', origin),
      likeKindExchange: bool(salesForm, 'likeKindExchange', origin),
      receivedInTrade: bool(salesForm, 'receivedInTrade', origin),
    },
    supplementary: {
      adjacentPropertyInd: bool(supplementary, 'adjacentPropertyInd', origin),
      buyerAppraisalInd: bool(supplementary, 'buyerAppraisalInd', origin),
      buyerAppraisalAmountMinor: money(supplementary, 'buyerAppraisalAmt', origin),
      sellerAppraisalInd: bool(supplementary, 'sellerAppraisalInd', origin),
      sellerAppraisalAmountMinor: money(supplementary, 'sellerAppraisalAmt', origin),
      giftInd: bool(supplementary, 'giftInd', origin),
      governmentInd: bool(supplementary, 'governmentInd', origin),
      legalActionInd: bool(supplementary, 'legalActionInd', origin),
      nameChangeInd: bool(supplementary, 'nameChangeInd', origin),
      nonListedInd: bool(supplementary, 'nonListedInd', origin),
      nonMarketPriceInd: bool(supplementary, 'nonMarketPriceInd', origin),
      relatedInd: bool(supplementary, 'relatedInd', origin),
      taxExemptInd: bool(supplementary, 'taxExemptInd', origin),
    },
    restricted: {
      partyContacts: [...buyers, ...sellers].map((p) => {
        const el = partyElement(root, p);
        return {
          partyKey: p.partyKey,
          daytimePhone: optional(text(el, 'daytimePhone')),
          email: optional(text(el, 'email')),
          contactNotes: optional(text(el, 'contactNotes')),
        };
      }),
      nonListedComment: optional(text(supplementary, 'nonListedComment')),
      nonMarketPriceComment: optional(text(supplementary, 'nonMarketPriceComment')),
      // Only retained when the department actually puts something there. The
      // element is present but empty in every extract we have seen.
      submitterFormRaw:
        submitterForm && (submitterForm.children.length > 0 || submitterForm.text.trim() !== '')
          ? serialize(submitterForm)
          : null,
    },
  };

  return { root, record, sourceRecordId: ecrvSourceRecordId(countyCode, crvNumber) };
}

// ---------------------------------------------------------------------------
// Element readers
// ---------------------------------------------------------------------------

function readParties(form: XmlElement, side: 'buyer' | 'seller', origin: string): readonly EcrvParty[] {
  const out: EcrvParty[] = [];
  // Ordinals are per block, matching document order, so a party's key is stable
  // for as long as the publisher keeps the party in the same position.
  for (const block of ['individuals', 'organizations'] as const) {
    childrenNamed(form, block).forEach((el, index) => {
      const ordinal = index + 1;
      out.push({
        partyKey: `${side}:${block}:${ordinal}`,
        side,
        block,
        ordinal,
        formElementId: optional(text(el, 'id')),
        firstName: optional(text(el, 'firstName')),
        middleName: optional(text(el, 'middleName')),
        lastName: optional(text(el, 'lastName')),
        nameSuffix: optional(text(el, 'nameSuffix')),
        organizationName: optional(text(el, 'organizationName')),
        isPerson: bool(el, 'person', origin),
        privateIndicator: bool(el, 'privateIndicator', origin),
        foreignAddress: bool(el, 'foreignAddress', origin),
        addressLine1: optional(text(el, 'addressLine1')),
        addressLine2: optional(text(el, 'addressLine2')),
        city: optional(text(el, 'city')),
        stateOrProvince: optional(text(el, 'stateOrProvince')),
        zip: optional(text(el, 'zip')),
        country: optional(text(el, 'country')),
      });
    });
  }
  return out;
}

function partyElement(root: XmlElement, party: EcrvParty): XmlElement {
  const form = childNamed(root, party.side === 'buyer' ? 'buyersForm' : 'sellersForm');
  const el = form ? childrenNamed(form, party.block)[party.ordinal - 1] : undefined;
  if (!el) fail('PARSE', `party ${party.partyKey} disappeared between reads`);
  return el;
}

const readParcel = (origin: string) => (el: XmlElement): EcrvParcel => ({
  formElementId: optional(text(el, 'id')),
  parcelId: optional(text(el, 'parcelId')),
  primary: bool(el, 'primary', origin),
});

const readAddress = (el: XmlElement): EcrvAddress => ({
  formElementId: optional(text(el, 'id')),
  street1: optional(text(el, 'street1')),
  street2: optional(text(el, 'street2')),
  city: optional(text(el, 'city')),
  zip: optional(text(el, 'zip')),
});

const readUse = (origin: string) => (el: XmlElement): EcrvUse => ({
  formElementId: optional(text(el, 'id')),
  tier1Code: optional(text(el, 'tier1Cde')),
  tier2Code: optional(text(el, 'tier2Cde')),
  tier3Code: optional(text(el, 'tier3Cde')),
  primaryInd: bool(el, 'primaryInd', origin),
});

const readProgram = (el: XmlElement): EcrvPropertyProgram => ({
  formElementId: optional(text(el, 'id')),
  programCode: optional(text(el, 'parcelProgramCode')),
  programAcres: optional(text(el, 'parcelProgramAcres')),
});

const readPersonalProperty = (origin: string) => (el: XmlElement): EcrvPersonalProperty => ({
  formElementId: optional(text(el, 'id')),
  description: optional(text(el, 'propertyDescription')),
  valueMinor: money(el, 'propertyValue', origin),
  selected: bool(el, 'selected', origin),
});

const readFinance = (origin: string) => (el: XmlElement, index: number): EcrvFinanceArrangement => ({
  ordinal: index + 1,
  formElementId: optional(text(el, 'id')),
  contractMortgageAmountMinor: money(el, 'contractMortgageAmt', origin),
  interestRatePercent: rate(el, 'interestRate', origin),
  interestRateTypeCode: optional(text(el, 'interestRateType')),
  paymentAmountMinor: money(el, 'monthlyPaymentAmt', origin),
  paymentTypeCode: optional(text(el, 'paymentType')),
  paymentTypeOther: optional(text(el, 'paymentTypeOther')),
  paymentForCode: optional(text(el, 'paymentFor')),
  numberOfPayments: int(el, 'numberPayments', origin),
  balloonAmountMinor: money(el, 'balloonPaymentAmt', origin),
  balloonDate: dateTime(el, 'balloonPaymentDate', origin),
  selected: bool(el, 'selected', origin),
});

// ---------------------------------------------------------------------------
// Typed scalar readers
// ---------------------------------------------------------------------------

function section(root: XmlElement, name: string, origin: string): XmlElement {
  const el = childNamed(root, name);
  if (!el) fail('PARSE', `${origin}: required section <${name}> is missing`);
  return el;
}

function text(el: XmlElement, name: string): string {
  return (childNamed(el, name)?.text ?? '').trim();
}

function optional(value: string): string | null {
  return value === '' ? null : value;
}

function normalizeCountyCode(raw: string): string {
  const trimmed = raw.trim();
  return trimmed === '' ? '' : trimmed.padStart(2, '0');
}

function bool(el: XmlElement, name: string, origin: string): boolean | null {
  const raw = text(el, name);
  if (raw === '') return null;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return fail('PARSE', `${origin}: <${name}> is "${raw}", which is not a boolean`);
}

function int(el: XmlElement, name: string, origin: string): number | null {
  const raw = text(el, name);
  if (raw === '') return null;
  if (!/^[+-]?\d+$/.test(raw)) fail('PARSE', `${origin}: <${name}> is "${raw}", which is not an integer`);
  return Number(raw);
}

function rate(el: XmlElement, name: string, origin: string): number | null {
  const raw = text(el, name);
  if (raw === '') return null;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(raw)) {
    fail('PARSE', `${origin}: <${name}> is "${raw}", which is not a rate`);
  }
  return Number(raw);
}

/** ISO 8601 with no offset stays offset-free: the submitter stated a wall clock. */
function dateTime(el: XmlElement, name: string, origin: string): string | null {
  const raw = text(el, name);
  if (raw === '') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.exec(raw);
  if (!match) fail('PARSE', `${origin}: <${name}> is "${raw}", which is not an ISO date or dateTime`);
  const [, y, mo, d, hh = '00', mm = '00', ss = '00', offset = ''] = match as unknown as string[];
  return `${y}-${mo}-${d}T${hh}:${mm}:${ss}${offset}`;
}

/**
 * Exact currency. "1234", "1234.5" and "1234.50" all become 123450 minor units
 * through string arithmetic, so no value is ever a floating-point approximation
 * of itself. More than two fractional digits is refused rather than rounded.
 */
export function parseMoneyMinor(raw: string): number | null {
  const value = raw.trim();
  if (value === '') return null;
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(value);
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) return null;
  const [, sign = '', whole = '', fraction = ''] = match as unknown as string[];
  if (fraction.length > 2) return null;
  const cents = `${whole === '' ? '0' : whole}${fraction.padEnd(2, '0')}`;
  const n = Number(cents);
  if (!Number.isSafeInteger(n)) return null;
  return sign === '-' ? -n : n;
}

function money(el: XmlElement, name: string, origin: string): number | null {
  const raw = text(el, name);
  if (raw === '') return null;
  const minor = parseMoneyMinor(raw);
  if (minor === null) fail('PARSE', `${origin}: <${name}> is "${raw}", which is not a currency amount`);
  return minor;
}

/** Canonical re-serialisation, used to retain unconstrained blocks verbatim. */
function serialize(el: XmlElement): string {
  const attrs = Object.keys(el.attrs)
    .sort()
    .map((k) => ` ${k}="${escapeXml(el.attrs[k] as string)}"`)
    .join('');
  const inner = el.children.map(serialize).join('') + escapeXml(el.text);
  return inner === '' ? `<${el.name}${attrs}/>` : `<${el.name}${attrs}>${inner}</${el.name}>`;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}
