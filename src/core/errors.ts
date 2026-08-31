/**
 * Error taxonomy. Every failure the runtime can produce is one of these kinds,
 * so run outcomes stay classifiable without matching on message strings.
 */
export type FabricErrorKind =
  | 'CONFIG' //           registry or adapter misconfiguration
  | 'TRANSPORT' //        could not reach or read the source
  | 'ACCESS_BLOCKED' //   source requires credentials or approval we do not hold
  | 'IMMUTABILITY' //     an attempt to overwrite retained source evidence
  | 'PARSE' //            bytes are not the declared format
  | 'SCHEMA_DRIFT' //     source structure no longer matches the pinned schema
  | 'VALIDATION' //       record-level rule violation
  | 'RESTRICTED' //       caller is not permitted to read this plane
  | 'REPLAY'; //          retained evidence failed verification

export class FabricError extends Error {
  readonly kind: FabricErrorKind;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(kind: FabricErrorKind, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'FabricError';
    this.kind = kind;
    this.detail = Object.freeze({ ...detail });
  }
}

export function fail(kind: FabricErrorKind, message: string, detail?: Record<string, unknown>): never {
  throw new FabricError(kind, message, detail);
}

export function isFabricError(e: unknown, kind?: FabricErrorKind): e is FabricError {
  return e instanceof FabricError && (kind === undefined || e.kind === kind);
}
