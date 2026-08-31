/**
 * The recorder index-export ingestion contract.
 *
 * There is no sanctioned machine interface to RecordEASE (see
 * docs/HENNEPIN-RECORDED-INSTRUMENTS.md), so this connector is written against a
 * **documented index-export shape** rather than a live API. That shape is what a
 * lawful delivery under Minn. Stat. ch. 13 would carry: the recorder's index
 * fields, one row per recorded document.
 *
 * Writing the adapter this way is not speculation dressed up as work. Every
 * field below corresponds to something the office demonstrably indexes — the fee
 * schedule charges per referenced document number, Torrens memorials are per
 * certificate, and the statutes require consecutive numbering with a certificate
 * reference. What is unknown is the *delivery format*, and that is isolated to
 * `parse.ts`: a different container swaps one file.
 *
 * The format mirrors DF-0D's streaming bundle so the whole bounded-memory
 * pipeline applies unchanged:
 *
 *   line 1     header   source metadata, window, expected count, schema digest
 *   lines 2..n rows     one index row per recorded document
 *   last line  trailer  delivered count, reconciliation
 */

export const RECORDER_BUNDLE_KIND = 'df.recorder.index/1';
export const RECORDER_TRAILER_KIND = 'df.recorder.index.trailer/1';

export type RecorderBundleHeader = {
  readonly kind: typeof RECORDER_BUNDLE_KIND;
  readonly sourceId: string;
  readonly countyFips: string;
  /** The recording-date or document-number window this delivery covers. */
  readonly window: {
    readonly kind: 'recorded_date_range' | 'document_number_range';
    readonly from: string;
    readonly to: string;
  };
  /**
   * The count the office states for the window. Without a stated denominator a
   * window cannot be called complete, only ingested.
   */
  readonly expectedRecordCount: number | null;
  /** Digest over the field names the delivery declares it contains. */
  readonly schemaDigest: string;
  readonly declaredFields: readonly string[];
  readonly preparedAt: string | null;
};

export type RecorderBundleTrailer = {
  readonly kind: typeof RECORDER_TRAILER_KIND;
  readonly deliveredRecordCount: number;
  readonly truncated: boolean;
  readonly notes: string | null;
};

/** A party as the recorder's index names it. */
export type RecorderIndexParty = {
  /** Verbatim role label from the index. */
  readonly role: string;
  readonly name: string;
  readonly sequence: number | null;
  readonly addressLine1?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly postalCode?: string | null;
};

export type RecorderIndexReference = {
  readonly documentNumber: string;
  /** 'abstract' | 'torrens' | omitted when the index does not say. */
  readonly registrationSystem?: string | null;
};

/** One row of the recorder index. */
export type RecorderIndexRow = {
  readonly documentNumber: string;
  /** Abstract and Torrens number independently; this is part of identity. */
  readonly registrationSystem?: string | null;
  readonly certificateOfTitleNumber?: string | null;
  readonly documentType: string;
  readonly recordedAt: string;
  readonly documentDate?: string | null;
  readonly parties?: readonly RecorderIndexParty[];
  /** County parcel identifiers, where the index carries them. */
  readonly parcelIds?: readonly string[];
  readonly legalDescriptions?: readonly string[];
  readonly referencedDocuments?: readonly RecorderIndexReference[];
  /**
   * Consideration only where the index states it as a field. Never derived from
   * tax stamps or fees.
   */
  readonly considerationAmount?: number | string | null;
  readonly principalAmount?: number | string | null;
  readonly maturityDate?: string | null;
  readonly bookPage?: string | null;
};

/** The parsed, typed form the normaliser consumes. */
export type RecorderRecord = {
  readonly documentNumber: string;
  readonly normalizedDocumentNumber: string;
  readonly registrationSystem: 'abstract' | 'torrens' | 'both' | 'unknown';
  readonly certificateOfTitleNumber: string | null;
  readonly documentTypeRaw: string;
  readonly recordedAt: string;
  readonly documentDate: string | null;
  readonly parties: readonly {
    readonly rawRole: string;
    readonly name: string;
    readonly sequence: number | null;
    readonly addressLine1: string | null;
    readonly city: string | null;
    readonly state: string | null;
    readonly postalCode: string | null;
  }[];
  readonly parcelIds: readonly string[];
  readonly legalDescriptions: readonly string[];
  readonly referencedDocuments: readonly {
    readonly documentNumber: string;
    readonly registrationSystem: 'abstract' | 'torrens' | 'both' | 'unknown';
  }[];
  readonly considerationMinor: number | null;
  readonly principalMinor: number | null;
  readonly maturityDate: string | null;
  readonly bookPage: string | null;
};

/** Field groups for change reporting, mirroring the assessor connector. */
export const RECORDER_FIELD_GROUPS = [
  'identity', 'type', 'parties', 'property', 'legal', 'references', 'financing',
] as const;
