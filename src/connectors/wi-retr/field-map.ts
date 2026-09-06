/**
 * The Wisconsin RETR public historical dataset, field by field.
 *
 * Pinned from the publisher's own "Downloadable RETR File CSV" documentation,
 * read from My Tax Account on 2026-09-05 (the page is reachable from
 * tap.revenue.wi.gov → Download Historical RETR Data → View CSV Documentation).
 * Every field name, ordinal, type and code list below is transcribed from that
 * page. Nothing here is remembered from the RETR form.
 *
 * ## Why the ordinals matter
 *
 * The CSV has no stable machine header — the first row is column titles in
 * English. Position IS the contract, so the ordinal is recorded and asserted
 * rather than the header text being trusted.
 *
 * ## The filing schema is NOT this schema
 *
 * The RETR *form* collects social security numbers, ITINs, FEINs, phone numbers,
 * email addresses and financing amounts, rates and terms. **None of those appear
 * in the public dataset**, and this file is the boundary that keeps them out: a
 * field that is not listed here does not exist as far as the connector is
 * concerned. See `docs/WISCONSIN-RETR.md` §"Filing schema is not dataset schema".
 *
 * ## What the CSV cannot say
 *
 * The publisher is explicit: "the parcel, grantor, and grantee sections only
 * show the first parcel, grantor, and grantee." A RETR with three grantors and
 * four parcels arrives as one CSV row describing one of each. That is why the
 * connector reads the XML distribution and treats the CSV as a cross-check —
 * see `parse-xml.ts`.
 */

/** What Reivesti does with a published field. */
export type FieldDisposition =
  /** Kept verbatim as source evidence, not interpreted. */
  | 'KEEP_RAW'
  /** Cleaned into a canonical representation by the normalization contract. */
  | 'NORMALIZE'
  /** Becomes part of a canonical entity's identity or a canonical column. */
  | 'CANONICALIZE'
  /** Retained with its observation date so change over time is visible. */
  | 'HISTORIZE'
  /** Routed to the restricted plane. Never a canonical field. */
  | 'RESTRICTED'
  /** Understood, deliberately not used yet, with the reason recorded. */
  | 'DERIVE_LATER'
  /** Read and dropped, with the reason recorded. */
  | 'IGNORE_WITH_REASON';

/** Which part of the return a field belongs to. Drives the canonical shape. */
export type FieldGroup =
  | 'transfer_identity'
  | 'conveyance'
  | 'relationship'
  | 'property'
  | 'grantor'
  | 'grantee'
  | 'economics'
  | 'prior_document'
  | 'financing'
  | 'restricted_party'
  | 'legal';

export type RetrField = {
  /** 1-based position in the CSV record. Position is the contract. */
  readonly ordinal: number;
  /** The publisher's column title, verbatim. */
  readonly name: string;
  /** The publisher's declared type. */
  readonly sourceType: 'String' | 'Date' | 'Number' | 'Decimal' | 'Currency';
  readonly group: FieldGroup;
  readonly disposition: FieldDisposition;
  /** The publisher's own description, verbatim where one is given. */
  readonly note: string;
};

/**
 * All 78 fields of the public CSV distribution, in publisher order.
 *
 * The XML distribution carries the same facts with repeating grantor, grantee
 * and parcel elements; this list is the authority for what a fact MEANS, and
 * `parse-xml.ts` is the authority for where it sits in the XML tree.
 */
export const WI_RETR_FIELDS: readonly RetrField[] = [
  // -- transfer identity ----------------------------------------------------
  { ordinal: 1, name: 'County', sourceType: 'String', group: 'transfer_identity', disposition: 'CANONICALIZE',
    note: 'The county the return was filed in. One of 72; a transfer spanning counties is filed as a separate RETR per county.' },
  { ordinal: 2, name: 'Document Number', sourceType: 'String', group: 'transfer_identity', disposition: 'CANONICALIZE',
    note: 'The document number recorded by the county. With County, this is the only publisher identity the dataset carries.' },
  { ordinal: 3, name: 'Recorded Date', sourceType: 'Date', group: 'transfer_identity', disposition: 'CANONICALIZE',
    note: 'The date the return was recorded by the county. MM-dd-yyyy. RECORDING_DATE, not the conveyance.' },

  // -- conveyance -----------------------------------------------------------
  { ordinal: 4, name: 'Document Type', sourceType: 'String', group: 'conveyance', disposition: 'CANONICALIZE',
    note: 'The document type that was filed. 40-value code list including deeds, land contracts, leases and WDOT instruments.' },
  { ordinal: 5, name: 'Document Explain', sourceType: 'String', group: 'conveyance', disposition: 'KEEP_RAW',
    note: 'Free text, present when Document Type is Other.' },
  { ordinal: 6, name: 'Conveyance Type', sourceType: 'String', group: 'conveyance', disposition: 'CANONICALIZE',
    note: 'The type of conveyance filed. This, not the document type, is what says whether a transfer was a sale.' },
  { ordinal: 7, name: 'Conveyance Explain', sourceType: 'String', group: 'conveyance', disposition: 'KEEP_RAW',
    note: 'Free text, present when Conveyance Type is Other.' },
  { ordinal: 8, name: 'Conveyance Date', sourceType: 'Date', group: 'conveyance', disposition: 'CANONICALIZE',
    note: 'The date the property was transferred. MM-dd-yyyy. CONVEYANCE_DATE — distinct from Recorded Date.' },
  { ordinal: 9, name: 'Original Land Contract Date', sourceType: 'Date', group: 'conveyance', disposition: 'CANONICALIZE',
    note: 'The date the original land contract was signed. Decides the 10c-per-$100 historical fee rate.' },

  // -- relationship ---------------------------------------------------------
  { ordinal: 10, name: 'Grantor/Grantee Relationship', sourceType: 'String', group: 'relationship', disposition: 'CANONICALIZE',
    note: 'The relationship between the grantor(s) and the grantee(s). The primary arm\'s-length signal the source states.' },
  { ordinal: 11, name: 'Grantor/Grantee Explain', sourceType: 'String', group: 'relationship', disposition: 'KEEP_RAW',
    note: 'Free text elaboration, e.g. "Father/son".' },
  { ordinal: 12, name: 'Ownership Type', sourceType: 'String', group: 'relationship', disposition: 'CANONICALIZE',
    note: 'How much ownership the grantee(s) receive: Full, Partial or Other. Partial means a partial-interest transfer.' },
  { ordinal: 13, name: 'Ownership Explain', sourceType: 'String', group: 'relationship', disposition: 'KEEP_RAW',
    note: 'Free text, e.g. "75% of ownership".' },
  { ordinal: 14, name: 'Rights Retained by Grantor', sourceType: 'String', group: 'relationship', disposition: 'CANONICALIZE',
    note: 'Easement, Life Estate, None or Other. A retained life estate is not a clean transfer of possession.' },
  { ordinal: 15, name: 'Rights Retained Explain', sourceType: 'String', group: 'relationship', disposition: 'KEEP_RAW',
    note: 'Free text.' },

  // -- property -------------------------------------------------------------
  { ordinal: 16, name: 'Municipality', sourceType: 'String', group: 'property', disposition: 'CANONICALIZE',
    note: 'The municipality the FIRST parcel is located in. Publisher warns names repeat across counties, so it is only meaningful with the county.' },
  { ordinal: 17, name: 'Part of Parcel Transferred', sourceType: 'String', group: 'property', disposition: 'CANONICALIZE',
    note: 'Entire parcel, less than 100%, improvements only, or new parcel. Distinguishes a whole-parcel conveyance from a fragment.' },
  { ordinal: 18, name: 'Parcel Number', sourceType: 'String', group: 'property', disposition: 'CANONICALIZE',
    note: 'The unique ID for the parcel. Publisher prefixes it with a TAB so Excel keeps leading zeros; the tab is a transport artefact and is stripped, the zeros are not.' },
  { ordinal: 19, name: 'Property Type', sourceType: 'String', group: 'property', disposition: 'CANONICALIZE',
    note: 'Land only, land and buildings, buildings only, condominium, timeshare, miscellaneous.' },
  { ordinal: 20, name: 'Property Use Type', sourceType: 'String', group: 'property', disposition: 'CANONICALIZE',
    note: 'The primary use, carrying the Wisconsin property class (Class 1 through 7).' },
  { ordinal: 21, name: 'Property Use Sub Type', sourceType: 'String', group: 'property', disposition: 'CANONICALIZE',
    note: 'A further description of the use, e.g. Restaurant/tavern.' },
  { ordinal: 22, name: 'Number of Units', sourceType: 'Number', group: 'property', disposition: 'NORMALIZE',
    note: 'The number of units in the building.' },
  { ordinal: 23, name: 'Property Explain', sourceType: 'String', group: 'property', disposition: 'KEEP_RAW', note: 'Free text.' },
  { ordinal: 24, name: 'Primary Residence of Grantee?', sourceType: 'String', group: 'property', disposition: 'CANONICALIZE',
    note: 'Yes/No. Owner-occupancy intent as declared at transfer.' },
  { ordinal: 25, name: 'Physical Address', sourceType: 'String', group: 'property', disposition: 'NORMALIZE',
    note: 'The situs address of the property transferred. Public situs data, and never on its own an identity for the property.' },
  { ordinal: 26, name: 'Section', sourceType: 'Number', group: 'property', disposition: 'KEEP_RAW', note: 'Public Land Survey section.' },
  { ordinal: 27, name: 'Township', sourceType: 'Number', group: 'property', disposition: 'KEEP_RAW', note: 'Public Land Survey township.' },
  { ordinal: 28, name: 'Range', sourceType: 'Number', group: 'property', disposition: 'KEEP_RAW', note: 'Public Land Survey range.' },
  { ordinal: 29, name: 'Meridian', sourceType: 'String', group: 'property', disposition: 'KEEP_RAW', note: 'East or West.' },
  { ordinal: 30, name: 'Subdivision Name', sourceType: 'String', group: 'property', disposition: 'KEEP_RAW', note: 'The name of the property\'s subdivision.' },
  { ordinal: 31, name: 'Lot Number', sourceType: 'String', group: 'property', disposition: 'KEEP_RAW', note: 'Lot number; may be a range such as "1-3".' },
  { ordinal: 32, name: 'Block Number', sourceType: 'String', group: 'property', disposition: 'KEEP_RAW', note: 'Block number.' },
  { ordinal: 33, name: 'Condominium Name', sourceType: 'String', group: 'property', disposition: 'KEEP_RAW', note: 'Condominium the property is part of.' },
  { ordinal: 34, name: 'Unit Number', sourceType: 'String', group: 'property', disposition: 'KEEP_RAW', note: 'Condominium unit number.' },
  { ordinal: 35, name: 'Square Feet', sourceType: 'Number', group: 'property', disposition: 'CANONICALIZE',
    note: 'The size of the lot in square feet. Canonical area, square-feet source unit.' },
  { ordinal: 36, name: 'Acres', sourceType: 'Decimal', group: 'property', disposition: 'CANONICALIZE',
    note: 'The size of the lot in acres. Canonical area, acres source unit — the same fact as Square Feet in a different unit.' },
  { ordinal: 37, name: 'MFL/PFC Acres', sourceType: 'Decimal', group: 'property', disposition: 'KEEP_RAW',
    note: 'Acres enrolled in Managed Forest Land or Private Forest Crop. A tax-programme fact, not lot size.' },
  { ordinal: 38, name: 'Feet of Water Frontage', sourceType: 'Number', group: 'property', disposition: 'KEEP_RAW',
    note: 'Water frontage footage; the publisher permits an estimate.' },

  // -- grantor --------------------------------------------------------------
  { ordinal: 39, name: 'Grantor Type', sourceType: 'String', group: 'grantor', disposition: 'CANONICALIZE',
    note: 'Individual, corporation, LLC, trust, estate, government body and so on. 21-value list.' },
  { ordinal: 40, name: 'Grantor Explain', sourceType: 'String', group: 'grantor', disposition: 'KEEP_RAW', note: 'Free text.' },
  { ordinal: 41, name: 'Grantor Name', sourceType: 'String', group: 'grantor', disposition: 'CANONICALIZE',
    note: 'The name of the grantor, as filed. "DOE, JOHN" for individuals. A name, never an identity.' },
  { ordinal: 42, name: 'Grantor Country', sourceType: 'String', group: 'restricted_party', disposition: 'RESTRICTED',
    note: 'The country of the grantor\'s MAILING address. Part of a contact record.' },
  { ordinal: 43, name: 'Grantor Address', sourceType: 'String', group: 'restricted_party', disposition: 'RESTRICTED',
    note: 'The grantor\'s MAILING address — a natural person\'s home address in the ordinary case. Restricted plane only.' },
  { ordinal: 44, name: 'Grantor Has Agent?', sourceType: 'String', group: 'grantor', disposition: 'KEEP_RAW', note: 'Yes/No.' },
  { ordinal: 45, name: 'Grantor Agent Name', sourceType: 'String', group: 'restricted_party', disposition: 'RESTRICTED',
    note: 'The grantor\'s agent. A named individual acting for a party; not a transfer fact.' },
  { ordinal: 46, name: 'Grantor Agent Country', sourceType: 'String', group: 'restricted_party', disposition: 'RESTRICTED', note: 'Agent mailing country.' },
  { ordinal: 47, name: 'Grantor Agent Address', sourceType: 'String', group: 'restricted_party', disposition: 'RESTRICTED', note: 'Agent mailing address.' },

  // -- grantee --------------------------------------------------------------
  { ordinal: 48, name: 'Grantee Type', sourceType: 'String', group: 'grantee', disposition: 'CANONICALIZE', note: 'Same 21-value list as Grantor Type.' },
  { ordinal: 49, name: 'Grantee Explain', sourceType: 'String', group: 'grantee', disposition: 'KEEP_RAW', note: 'Free text.' },
  { ordinal: 50, name: 'Grantee Name', sourceType: 'String', group: 'grantee', disposition: 'CANONICALIZE', note: 'The name of the grantee, as filed.' },
  { ordinal: 51, name: 'Grantee Country', sourceType: 'String', group: 'restricted_party', disposition: 'RESTRICTED', note: 'Grantee mailing country.' },
  { ordinal: 52, name: 'Grantee Address', sourceType: 'String', group: 'restricted_party', disposition: 'RESTRICTED',
    note: 'The grantee\'s MAILING address. Restricted plane only.' },
  { ordinal: 53, name: 'Grantee Has Agent?', sourceType: 'String', group: 'grantee', disposition: 'KEEP_RAW', note: 'Yes/No.' },
  { ordinal: 54, name: 'Grantee Agent Name', sourceType: 'String', group: 'restricted_party', disposition: 'RESTRICTED', note: 'Agent name.' },
  { ordinal: 55, name: 'Grantee Agent Country', sourceType: 'String', group: 'restricted_party', disposition: 'RESTRICTED', note: 'Agent mailing country.' },
  { ordinal: 56, name: 'Grantee Agent Address', sourceType: 'String', group: 'restricted_party', disposition: 'RESTRICTED', note: 'Agent mailing address.' },

  // -- economics ------------------------------------------------------------
  { ordinal: 57, name: 'Fee Exemption', sourceType: 'String', group: 'economics', disposition: 'CANONICALIZE',
    note: 'The ch. 77.25 exemption claimed, as "code - label". Absent means the transfer was fee-liable.' },
  { ordinal: 58, name: 'Estimated Value', sourceType: 'Currency', group: 'economics', disposition: 'CANONICALIZE',
    note: 'The estimated value of the property transferred. Used where there is no arm\'s-length price; NOT interchangeable with Sale Price.' },
  { ordinal: 59, name: 'Sale Price', sourceType: 'Currency', group: 'economics', disposition: 'CANONICALIZE',
    note: 'The sale price of the property sold. The consideration, when the conveyance had one.' },
  { ordinal: 60, name: 'Transfer Fee Due', sourceType: 'Currency', group: 'economics', disposition: 'CANONICALIZE',
    note: 'The total tax owed. A TAX, not a price: 30c per $100 of value under s. 77.22(1). Never a consideration.' },
  { ordinal: 66, name: 'Personal Property Excluded', sourceType: 'Currency', group: 'economics', disposition: 'CANONICALIZE',
    note: 'Value of personal property transferred but EXCLUDED from the real-estate value. Subtracted already; do not subtract twice.' },
  { ordinal: 67, name: 'Personal Property Included', sourceType: 'Currency', group: 'economics', disposition: 'CANONICALIZE',
    note: 'Value of property exempt from local property tax INCLUDED in the real-estate value. The publisher\'s own label is confusingly similar to field 66; the two move opposite ways.' },

  // -- prior document -------------------------------------------------------
  { ordinal: 61, name: 'Previous Document Number', sourceType: 'String', group: 'prior_document', disposition: 'KEEP_RAW',
    note: 'The document number of a previous return. Evidence of a chain, not itself an instrument.' },
  { ordinal: 62, name: 'State Where Filed', sourceType: 'String', group: 'prior_document', disposition: 'KEEP_RAW', note: 'Where the relevant prior document was filed.' },
  { ordinal: 63, name: 'Date Filed', sourceType: 'Date', group: 'prior_document', disposition: 'CANONICALIZE',
    note: 'When the relevant prior document was filed. FILING_DATE semantics, a third date distinct from conveyance and recording.' },
  { ordinal: 64, name: 'Acquired by Corporation Date', sourceType: 'Date', group: 'prior_document', disposition: 'KEEP_RAW',
    note: 'Supports specific ch. 77.25 corporate exemptions.' },
  { ordinal: 65, name: 'Domestic Partnership Date', sourceType: 'Date', group: 'prior_document', disposition: 'KEEP_RAW',
    note: 'Supports the 8n domestic-partner exemption.' },

  // -- restricted party (tax bill) and preparer -----------------------------
  { ordinal: 68, name: 'Preparer Name', sourceType: 'String', group: 'restricted_party', disposition: 'RESTRICTED',
    note: 'The person who prepared the return. Neither party to the transfer; a named individual doing their job.' },
  { ordinal: 69, name: 'Tax Bill Name', sourceType: 'String', group: 'restricted_party', disposition: 'RESTRICTED',
    note: 'Who receives the tax bill. The same shape of fact as a Hennepin taxpayer line, and treated the same way.' },
  { ordinal: 70, name: 'Tax Bill Country', sourceType: 'String', group: 'restricted_party', disposition: 'RESTRICTED', note: 'Tax bill mailing country.' },
  { ordinal: 71, name: 'Tax Bill Address', sourceType: 'String', group: 'restricted_party', disposition: 'RESTRICTED', note: 'Tax bill mailing address.' },

  // -- financing ------------------------------------------------------------
  //
  // Booleans only. The FORM collects amount financed, APR and term; the public
  // dataset does not, and this connector must never imply that it does.
  { ordinal: 72, name: 'Has Financing?', sourceType: 'String', group: 'financing', disposition: 'CANONICALIZE', note: 'Yes/No. Whether financing was used at all.' },
  { ordinal: 73, name: 'Financing - Conventional', sourceType: 'String', group: 'financing', disposition: 'CANONICALIZE', note: 'Yes/No.' },
  { ordinal: 74, name: 'Financing - Government', sourceType: 'String', group: 'financing', disposition: 'CANONICALIZE', note: 'Yes/No.' },
  { ordinal: 75, name: 'Financing - Assumed Existing', sourceType: 'String', group: 'financing', disposition: 'CANONICALIZE', note: 'Yes/No.' },
  { ordinal: 76, name: 'Financing - From Seller', sourceType: 'String', group: 'financing', disposition: 'CANONICALIZE',
    note: 'Yes/No. Seller financing — the one financing flag with obvious downstream meaning, and still only a flag.' },
  { ordinal: 77, name: 'Financing - Third Party', sourceType: 'String', group: 'financing', disposition: 'CANONICALIZE', note: 'Yes/No.' },

  // -- legal ----------------------------------------------------------------
  { ordinal: 78, name: 'Legal Description', sourceType: 'String', group: 'legal', disposition: 'KEEP_RAW',
    note: 'The full legal description. Also where parcels 11 and beyond go when a RETR lists more than ten.' },
];

/** Fields whose values go to the restricted plane and never to a canonical row. */
export const WI_RETR_RESTRICTED_FIELDS: ReadonlySet<string> = new Set(
  WI_RETR_FIELDS.filter((f) => f.disposition === 'RESTRICTED').map((f) => f.name),
);

/**
 * Fields the RETR *form* collects that the public dataset does not publish.
 *
 * Recorded so that "the connector does not read this" is a documented decision
 * rather than an omission somebody later mistakes for a bug — and so that no
 * future reader assumes RETR is a source of financing terms or tax IDs.
 */
export const WI_RETR_FILING_ONLY_FIELDS: readonly string[] = [
  'Grantor SSN / ITIN / FEIN',
  'Grantee SSN / ITIN / FEIN',
  'Grantor phone number',
  'Grantee phone number',
  'Grantor email address',
  'Grantee email address',
  'Preparer phone number',
  'Preparer email address',
  'Agent phone number and email address',
  'Financing amount financed',
  'Financing rate (APR)',
  'Financing term in months',
  'Marketing method, days on market, realtor/broker name and phone',
  'Value subject to fee',
];
