/**
 * Prints a fixed attestation vector for the Rust settlement test.
 *
 * The two test suites each check their own encoder against their own decoder,
 * so they can pass while disagreeing about the wire format. The Rust test
 * `settle_accepts_an_attestation_signed_by_the_typescript_attester` closes that
 * gap by consuming a signature produced here. Regenerate and paste the values
 * if the payload layout ever changes intentionally.
 *
 *   bun run scripts/attestation-vector.ts
 */
import { encodePayload, type ArrivalPayload } from "../src/payload.ts";
import {
  privateKeyFromSeed,
  publicKeyFromPrivate,
  signPayload,
} from "../src/signing.ts";

const seed = new Uint8Array(32).fill(7);
const privateKey = privateKeyFromSeed(seed);
const publicKey = publicKeyFromPrivate(privateKey);

// Matches the constants in test_freight_delay.rs.
const payload: ArrivalPayload = {
  pool: new Uint8Array(32).fill(11), // ATTESTER_POOL_HEX
  shipmentId: 27n,
  actualDelivery: 1_700_001_300n, // BASE_TS + SLA_DELTA + 100
  terminalCode: 4201n,
  nonce: 1n,
};

const message = encodePayload(payload);
const signature = signPayload(payload, privateKey);
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

console.log(`ATTESTER_POOL_HEX   = "${hex(payload.pool)}"`);
console.log(`ATTESTER_PUBKEY_HEX = "${hex(publicKey)}"`);
console.log(`ATTESTER_MSG_HEX    = "${hex(message)}"`);
console.log(`ATTESTER_SIG_HEX    = "${hex(signature)}"`);
