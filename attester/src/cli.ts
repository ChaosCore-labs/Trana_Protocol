/**
 * Attester CLI (CHA-32): turn a shipment's arrival into a signed attestation.
 *
 *   bun run src/cli.ts --pool-hex <64 hex> --seed-hex <64 hex> \
 *     --shipment 27 --nonce 1 --arrival 1700000000 [--terminal 4201] [--json]
 *
 * The signing key comes either as a raw `--seed-hex` or as a Solana keypair file,
 * `--keypair ~/.config/solana/id.json` — a wallet's own key can be the pool's
 * `oracle_authority`, and this reads just its seed instead of asking you to copy it.
 *
 * Prints the 64-byte message and its ed25519 signature as hex — exactly the
 * bytes `settle_policy` verifies, plus the public key that must be the pool's
 * `oracle_authority`. It does not submit: this package carries no Solana
 * dependency, so the crank (`freight_delay/client/crank.ts`) builds the
 * transaction around the signature.
 *
 * Inputs are hex, not base58: decoding a pool address is the caller's client's
 * job (`getAddressEncoder` in `@solana/kit`), and this package stays dependency
 * free on the wire format alone.
 */

import { readFileSync } from "node:fs";

import { type ArrivalPayload, encodePayload } from "./payload.ts";
import { publicKeyFromPrivate, seedFromKeypairJson, signPayload } from "./signing.ts";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

function required(name: string): string {
  const value = arg(name);
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

function fromHex(hex: string, bytes: number): Uint8Array {
  if (hex.length !== bytes * 2) {
    throw new Error(`expected ${bytes * 2} hex chars, got ${hex.length}`);
  }
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

const pool = fromHex(required("pool-hex"), 32);

const seedHex = arg("seed-hex");
const keypairPath = arg("keypair");
let seed: Uint8Array;
if (seedHex !== undefined && keypairPath === undefined) {
  seed = fromHex(seedHex, 32);
} else if (keypairPath !== undefined && seedHex === undefined) {
  seed = seedFromKeypairJson(JSON.parse(readFileSync(keypairPath, "utf8")));
} else {
  throw new Error("pass exactly one of --seed-hex <64 hex> or --keypair <path>");
}

const payload: ArrivalPayload = {
  pool,
  shipmentId: BigInt(required("shipment")),
  actualDelivery: BigInt(required("arrival")),
  terminalCode: BigInt(arg("terminal") ?? "0"),
  nonce: BigInt(required("nonce")),
};

const message = encodePayload(payload);
const signature = signPayload(payload, seed);
const publicKey = publicKeyFromPrivate(seed);

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify({
      pool: toHex(pool),
      shipmentId: payload.shipmentId.toString(),
      actualDelivery: payload.actualDelivery.toString(),
      terminalCode: payload.terminalCode.toString(),
      nonce: payload.nonce.toString(),
      publicKey: toHex(publicKey),
      message: toHex(message),
      signature: toHex(signature),
    }),
  );
} else {
  console.log(`oracle_authority ${toHex(publicKey)}`);
  console.log(`message          ${toHex(message)}`);
  console.log(`signature        ${toHex(signature)}`);
}
