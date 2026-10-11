import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { attest } from "../src/attest.ts";
import { type ArrivalPayload, PAYLOAD_LEN, decodePayload, encodePayload } from "../src/payload.ts";
import { SimulatedSource } from "../src/simulated-source.ts";
import {
  generateAttesterKeypair,
  privateKeyFromSeed,
  publicKeyFromPrivate,
  signPayload,
  verifyPayload,
} from "../src/signing.ts";

const SAMPLE: ArrivalPayload = {
  shipmentId: 0xdead_beefn,
  actualDelivery: 1_760_000_000n,
  terminalCode: 42n,
  nonce: 7n,
};

describe("payload encoding", () => {
  it("is 32 bytes and round-trips", () => {
    const bytes = encodePayload(SAMPLE);
    assert.equal(bytes.length, PAYLOAD_LEN);
    assert.deepEqual(decodePayload(bytes), SAMPLE);
  });

  it("lays out fields little-endian in the documented order", () => {
    const bytes = encodePayload(SAMPLE);
    const view = new DataView(bytes.buffer);
    assert.equal(view.getBigUint64(0, true), SAMPLE.shipmentId);
    assert.equal(view.getBigInt64(8, true), SAMPLE.actualDelivery);
    assert.equal(view.getBigUint64(16, true), SAMPLE.terminalCode);
    assert.equal(view.getBigUint64(24, true), SAMPLE.nonce);
  });

  it("rejects out-of-range values", () => {
    assert.throws(() => encodePayload({ ...SAMPLE, shipmentId: -1n }), RangeError);
    assert.throws(() => encodePayload({ ...SAMPLE, nonce: 1n << 64n }), RangeError);
  });

  it("rejects a wrong-length decode", () => {
    assert.throws(() => decodePayload(new Uint8Array(31)), RangeError);
  });
});

describe("ed25519 signing", () => {
  it("signs a payload the matching public key verifies", () => {
    const { publicKey, privateKey } = generateAttesterKeypair();
    assert.equal(publicKey.length, 32);
    const signature = signPayload(SAMPLE, privateKey);
    assert.equal(signature.length, 64);
    assert.equal(verifyPayload(SAMPLE, signature, publicKey), true);
  });

  it("derives the same public key from a seed via either path", () => {
    const seed = new Uint8Array(32).fill(9);
    const der = privateKeyFromSeed(seed);
    const fromDer = publicKeyFromPrivate(der);
    const signature = signPayload(SAMPLE, der);
    assert.equal(verifyPayload(SAMPLE, signature, fromDer), true);
  });

  it("fails verification when a field is tampered with", () => {
    const { publicKey, privateKey } = generateAttesterKeypair();
    const signature = signPayload(SAMPLE, privateKey);
    // Replay guard: same signature, different nonce, must not verify.
    assert.equal(verifyPayload({ ...SAMPLE, nonce: 8n }, signature, publicKey), false);
    assert.equal(verifyPayload({ ...SAMPLE, actualDelivery: 1n }, signature, publicKey), false);
  });

  it("rejects a signature from a different key", () => {
    const a = generateAttesterKeypair();
    const b = generateAttesterKeypair();
    const signature = signPayload(SAMPLE, a.privateKey);
    assert.equal(verifyPayload(SAMPLE, signature, b.publicKey), false);
  });
});

describe("SimulatedSource", () => {
  const NOW = 1_760_000_500n;

  it("returns the scripted arrival", async () => {
    const source = new SimulatedSource({
      arrivals: { "1": { actualDelivery: NOW, terminalCode: 42n } },
      now: () => NOW,
    });
    const arrival = await source.fetch(1n);
    assert.deepEqual(arrival, { actualDelivery: NOW, terminalCode: 42n });
  });

  it("returns null for an unknown shipment", async () => {
    const source = new SimulatedSource({ now: () => NOW });
    assert.equal(await source.fetch(999n), null);
  });

  it("holds an arrival until its delay elapses", async () => {
    let clock = NOW;
    const source = new SimulatedSource({
      arrivals: { "1": { actualDelivery: NOW, afterSeconds: 60 } },
      now: () => clock,
      startedAt: NOW,
    });
    assert.equal(await source.fetch(1n), null);
    clock = NOW + 60n;
    assert.notEqual(await source.fetch(1n), null);
  });
});

describe("attest", () => {
  it("produces a verifiable attestation end to end", async () => {
    const { publicKey, privateKey } = generateAttesterKeypair();
    const source = new SimulatedSource({
      arrivals: { "77": { actualDelivery: 1_760_000_000n, terminalCode: 3n } },
    });

    const result = await attest(source, 77n, { nonce: 5n, privateKeyDer: privateKey });
    assert.ok(result);
    assert.equal(result.simulated, true);
    assert.equal(result.source, "simulated");
    assert.deepEqual(decodePayload(result.message), {
      shipmentId: 77n,
      actualDelivery: 1_760_000_000n,
      terminalCode: 3n,
      nonce: 5n,
    });
    assert.equal(verifyPayload(result.payload, result.signature, publicKey), true);
  });

  it("returns null when the shipment has not arrived", async () => {
    const { privateKey } = generateAttesterKeypair();
    const source = new SimulatedSource();
    const result = await attest(source, 1n, { nonce: 0n, privateKeyDer: privateKey });
    assert.equal(result, null);
  });

  it("binds the signature to the nonce", async () => {
    const { publicKey, privateKey } = generateAttesterKeypair();
    const source = new SimulatedSource({ arrivals: { "1": { actualDelivery: 1n } } });
    const result = await attest(source, 1n, { nonce: 10n, privateKeyDer: privateKey });
    assert.ok(result);
    // Same payload, different nonce: the captured signature must be useless.
    assert.equal(verifyPayload({ ...result.payload, nonce: 11n }, result.signature, publicKey), false);
  });
});