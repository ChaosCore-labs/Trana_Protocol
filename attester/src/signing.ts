/**
 * Attester signing (CHA-32 / CHA-16).
 *
 * The attester holds an ed25519 key and signs the 64-byte payload; the program
 * verifies that signature via the ed25519 precompile. This is the same primitive
 * Pyth/Chainlink/Switchboard use — we are simply the publisher.
 *
 * A key here is a raw 32-byte ed25519 seed (RFC 8032). There is no DER/PKCS#8
 * wrapping: the seed in config is the whole secret, and its public half is the
 * 32 bytes the pool stores as `oracle_authority`.
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";

import { type ArrivalPayload, encodePayload } from "./payload.ts";

// noble ships no hash function; ed25519 (RFC 8032) needs SHA-512, so wire it once.
ed.hashes.sha512 = (message: Uint8Array) => sha512(message);

/** Length of an ed25519 seed and of its public key. */
export const KEY_LEN = 32;
export interface AttesterKeypair {
  /** Raw 32-byte public key — the value stored on-chain as `oracle_authority`. */
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export function privateKeyFromSeed(seed: Uint8Array): Uint8Array {
  if (seed.length !== KEY_LEN) {
    throw new RangeError(`ed25519 seed must be ${KEY_LEN} bytes, got ${seed.length}`);
  }
  return seed;
}

/**
 * A Solana CLI keypair file is a JSON array of the 64 bytes `seed || publicKey`, so its
 * first 32 are the ed25519 seed this package signs with. That is what lets a wallet —
 * `~/.config/solana/id.json` — also be the pool's `oracle_authority`.
 */
export function seedFromKeypairJson(value: unknown): Uint8Array {
  if (!Array.isArray(value)) {
    throw new TypeError("a keypair file is a JSON array of bytes");
  }
  if (value.length < KEY_LEN) {
    throw new RangeError(`expected at least ${KEY_LEN} bytes, got ${value.length}`);
  }
  const seed = value.slice(0, KEY_LEN);
  if (seed.some((byte) => typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new TypeError("a keypair file holds one byte per entry");
  }
  return Uint8Array.from(seed as number[]);
}

export function generateAttesterKeypair(): AttesterKeypair {
  const privateKey = crypto.getRandomValues(new Uint8Array(KEY_LEN));
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
}

export function publicKeyFromPrivate(seed: Uint8Array): Uint8Array {
  return ed.getPublicKey(privateKeyFromSeed(seed));
}

/** Sign the canonical 64-byte encoding of a payload. Returns a 64-byte signature. */
export function signPayload(payload: ArrivalPayload, seed: Uint8Array): Uint8Array {
  return ed.sign(encodePayload(payload), privateKeyFromSeed(seed));
}

export function verifyPayload(
  payload: ArrivalPayload,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  return ed.verify(signature, encodePayload(payload), publicKey);
}
