// Pure error-code mapper for the Bridge /api/message response.
//
// Extracted from `bridgeGetMessage` so the classification is unit-testable
// without a server runtime. Keeping this module pure guarantees the UI's
// ghost-cleanup contract (only NOT_FOUND may tombstone a local index row)
// cannot silently regress if the mapping is edited.

export type BridgeMessageErrorCode =
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "UNAVAILABLE"
  | "NETWORK"
  | "UNKNOWN";

export interface BridgeCallFailure {
  status?: number;
  unavailable?: boolean;
}

/**
 * Map a bridge-call failure to the typed error code the UI consumes.
 *
 * Rules (locked by tests):
 *   * `unavailable === true`                 -> "UNAVAILABLE"
 *   * HTTP 404                                -> "NOT_FOUND"
 *   * HTTP 401 / 403                          -> "UNAUTHORIZED"
 *   * `status == null` (fetch threw / abort)  -> "NETWORK"
 *   * everything else                         -> "UNKNOWN"
 *
 * A NETWORK / UNKNOWN / UNAUTHORIZED / UNAVAILABLE response MUST NEVER be
 * turned into NOT_FOUND — that would let a transient hiccup silently
 * tombstone a real row.
 */
export function classifyBridgeMessageFailure(failure: BridgeCallFailure): BridgeMessageErrorCode {
  if (failure.unavailable) return "UNAVAILABLE";
  if (failure.status === 404) return "NOT_FOUND";
  if (failure.status === 401 || failure.status === 403) return "UNAUTHORIZED";
  if (failure.status == null) return "NETWORK";
  return "UNKNOWN";
}
