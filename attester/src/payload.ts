/**
 * The signed delivery-attestation payload.
 *
 * This layout is the contract between the off-chain attester and `settle_policy`
 * on-chain. The program verifies an ed25519 signature over exactly these bytes.
 * Changing field order or width here is a breaking change to CHA-16.
 *
 * Encoding: 64 bytes, little-endian, in this order:
 *   pool            [u8; 32]  the PoolConfig account it is for
 *   shipment_id     u64
 *   actual_delivery i64  (unix seconds, terminal arrival)
 *   terminal_code   u64
 *   nonce           u64
 *
 * `pool` binds a signature to one pool. Without it a signature travels between
 * pools that share an attester, because `nonce` is checked against a policy id
 * the buyer chooses and every pool numbers its policies from zero. `nonce`
 * still binds the signature to one policy within that pool (replay guard, see
 * CHA-16).
 */

export const POOL_LEN = 32;
export const PAYLOAD_LEN = 64;

export interface ArrivalPayload {
  /** The `PoolConfig` the attestation is for, as 32 raw bytes. */
  pool: Uint8Array;
  shipmentId: bigint;
  actualDelivery: bigint;
  terminalCode: bigint;
  nonce: bigint;
}

const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

function writeU64LE(view: DataView, offset: number, value: bigint): void {
  view.setBigUint64(offset, value, true);
}

/** Encode a payload to the 64-byte little-endian message the program verifies. */
export function encodePayload(payload: ArrivalPayload): Uint8Array {
  if (payload.pool.length !== POOL_LEN) {
    throw new RangeError(`pool must be ${POOL_LEN} bytes, got ${payload.pool.length}`);
  }
  if (payload.shipmentId < 0n || payload.shipmentId > U64_MAX) {
    throw new RangeError(`shipmentId out of u64 range: ${payload.shipmentId}`);
  }
  if (payload.actualDelivery < I64_MIN || payload.actualDelivery > I64_MAX) {
    throw new RangeError(`actualDelivery out of i64 range: ${payload.actualDelivery}`);
  }
  if (payload.terminalCode < 0n || payload.terminalCode > U64_MAX) {
    throw new RangeError(`terminalCode out of u64 range: ${payload.terminalCode}`);
  }
  if (payload.nonce < 0n || payload.nonce > U64_MAX) {
    throw new RangeError(`nonce out of u64 range: ${payload.nonce}`);
  }

  const bytes = new Uint8Array(PAYLOAD_LEN);
  const view = new DataView(bytes.buffer);
  bytes.set(payload.pool, 0);
  writeU64LE(view, 32, payload.shipmentId);
  view.setBigInt64(40, payload.actualDelivery, true);
  writeU64LE(view, 48, payload.terminalCode);
  writeU64LE(view, 56, payload.nonce);
  return bytes;
}

/** Decode the 64-byte message back into a payload. Throws on a wrong length. */
export function decodePayload(bytes: Uint8Array): ArrivalPayload {
  if (bytes.length !== PAYLOAD_LEN) {
    throw new RangeError(`expected ${PAYLOAD_LEN} bytes, got ${bytes.length}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    pool: bytes.slice(0, POOL_LEN),
    shipmentId: view.getBigUint64(32, true),
    actualDelivery: view.getBigInt64(40, true),
    terminalCode: view.getBigUint64(48, true),
    nonce: view.getBigUint64(56, true),
  };
}