/**
 * Attestation: turn a source's arrival into a signed payload for `settle_policy`.
 *
 * This is the whole off-chain job. `attest` is source-agnostic — simulated and
 * Terminal49 go through the identical path, so the on-chain verify is unchanged
 * by which source produced the data.
 */

import { type ArrivalPayload, encodePayload } from "./payload.ts";
import { signPayload } from "./signing.ts";
import type { ArrivalSource } from "./source.ts";

export interface SignedAttestation {
  payload: ArrivalPayload;
  /** 64-byte encoding of `payload` — what the ed25519 precompile receives. */
  message: Uint8Array;
  /** 64-byte ed25519 signature. */
  signature: Uint8Array;
  /** Which source produced this, for logging. */
  source: string;
  simulated: boolean;
}

export interface AttestOptions {
  /** The `PoolConfig` this attestation is for, as 32 raw bytes. */
  pool: Uint8Array;
  /** Replay guard: binds the signature to one policy (see CHA-16). */
  nonce: bigint;
  /** Raw 32-byte ed25519 seed. */
  privateKey: Uint8Array;
}

/**
 * Produce a signed attestation for a shipment, or null if the source has no
 * arrival yet. Never invents a timestamp: absence is reported as null.
 */
export async function attest(
  source: ArrivalSource & { simulated?: boolean },
  shipmentId: bigint,
  options: AttestOptions,
): Promise<SignedAttestation | null> {
  const arrival = await source.fetch(shipmentId);
  if (!arrival) return null;

  const payload: ArrivalPayload = {
    pool: options.pool,
    shipmentId,
    actualDelivery: arrival.actualDelivery,
    terminalCode: arrival.terminalCode,
    nonce: options.nonce,
  };

  return {
    payload,
    message: encodePayload(payload),
    signature: signPayload(payload, options.privateKey),
    source: source.name,
    simulated: source.simulated ?? false,
  };
}