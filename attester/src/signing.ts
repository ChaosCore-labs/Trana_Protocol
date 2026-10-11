/**
 * Attester signing (CHA-32 / CHA-16).
 *
 * The attester holds an ed25519 keypair. It signs the 32-byte payload; the
 * program verifies that signature via the ed25519 precompile. This is the same
 * primitive Pyth/Chainlink/Switchboard use — we are simply the publisher.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

import { type ArrivalPayload, encodePayload } from "./payload.ts";

export interface AttesterKeypair {
  /** Raw 32-byte ed25519 public key — the value stored on-chain as oracle_authority. */
  publicKey: Uint8Array;
  /** PKCS#8 DER private key, used only to sign. */
  privateKey: Uint8Array;
}

type NodeEd25519Key = ReturnType<typeof createPrivateKey> | ReturnType<typeof createPublicKey>;

/** PKCS#8 DER prefix for a raw ed25519 private key seed (RFC 8410). */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Wrap a raw 32-byte ed25519 seed as a PKCS#8 DER key Node's crypto accepts. */
export function privateKeyFromSeed(seed: Uint8Array): Uint8Array {
  if (seed.length !== 32) {
    throw new RangeError(`ed25519 seed must be 32 bytes, got ${seed.length}`);
  }
  return new Uint8Array(Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]));
}

/** Generate a fresh attester keypair (raw public key + PKCS#8 private key). */
export function generateAttesterKeypair(): AttesterKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  // SPKI DER for ed25519 is a fixed 12-byte header followed by the raw 32 bytes.
  return {
    publicKey: new Uint8Array(spki.subarray(spki.length - 32)),
    privateKey: new Uint8Array(pkcs8),
  };
}

function importPrivate(der: Uint8Array): NodeEd25519Key {
  return createPrivateKey({ key: Buffer.from(der), format: "der", type: "pkcs8" });
}

/** Raw 32-byte public key from a PKCS#8 private key. */
export function publicKeyFromPrivate(der: Uint8Array): Uint8Array {
  const spki = createPublicKey(importPrivate(der)).export({ type: "spki", format: "der" });
  return new Uint8Array(spki.subarray(spki.length - 32));
}

/** Sign the canonical 32-byte encoding of a payload. Returns a 64-byte signature. */
export function signPayload(payload: ArrivalPayload, privateKeyDer: Uint8Array): Uint8Array {
  const message = encodePayload(payload);
  // Ed25519 takes no digest algorithm.
  const sig = sign(null, message, importPrivate(privateKeyDer));
  return new Uint8Array(sig);
}

/** Verify a signature over a payload against a raw 32-byte ed25519 public key. */
export function verifyPayload(
  payload: ArrivalPayload,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(publicKey),
  ]);
  const key = createPublicKey({ key: spki, format: "der", type: "spki" });
  return verify(null, encodePayload(payload), key, Buffer.from(signature));
}