/**
 * Data-source interface for the attester (CHA-32).
 *
 * The program only ever sees a signed payload, so swapping the source changes
 * nothing on-chain. Two implementations:
 *   - Terminal49Source (primary, real carrier events)
 *   - SimulatedSource  (required backup, see simulated-source.ts)
 */

export interface Arrival {
  /** Terminal-arrival timestamp, unix seconds. */
  actualDelivery: bigint;
  /** Destination terminal identifier, mapped from the carrier event. */
  terminalCode: bigint;
}

export interface ArrivalSource {
  readonly name: string;
  /**
   * Return the attested arrival for a shipment, or null if it has not arrived.
   * Implementations must never invent a time: null means "no attestation yet".
   */
  fetch(shipmentId: bigint): Promise<Arrival | null>;
}