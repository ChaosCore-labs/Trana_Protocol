import { encodePayload, type ArrivalPayload } from "../src/payload.ts";
import { privateKeyFromSeed, publicKeyFromPrivate, signPayload } from "../src/signing.ts";

// Deterministic seed: the same one the Rust test will use.
const seed = new Uint8Array(32).fill(7);
const der = privateKeyFromSeed(seed);
const pub = publicKeyFromPrivate(der);

const payload: ArrivalPayload = {
  shipmentId: 27n,          // SHIPMENT_ID in the Rust suite
  actualDelivery: 1_700_001_300n, // BASE_TS + SLA_DELTA + 100
  terminalCode: 4201n,      // TERMINAL_CODE
  nonce: 1n,                // policy id
};
const message = encodePayload(payload);
const signature = signPayload(payload, der);

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
console.log("SEED_HEX   =", hex(seed));
console.log("PUBKEY_HEX =", hex(pub));
console.log("MSG_HEX    =", hex(message));
console.log("SIG_HEX    =", hex(signature));
console.log("siglen     =", signature.length, "msglen =", message.length, "pklen =", pub.length);
