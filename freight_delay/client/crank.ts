/**
 * Crank: settle every matured policy of one pool that has an attested arrival.
 *
 * `settle_policy` is permissionless and its outcome is fully determined by
 * on-chain state, so automation lives off chain (CHA-19): this scans the pool's
 * live policies, asks the source for each shipment's arrival, and submits the
 * ed25519 attestation plus the settlement. The crank keypair is unprivileged —
 * the worst case if it leaks is that someone else pays fees.
 */

import { getBase58Decoder, type Instruction, type TransactionSigner } from "@solana/kit";

import type { ArrivalSource } from "../../attester/src/source.ts";
import { POLICY_DISCRIMINATOR, getPolicyDecoder } from "./generated/accounts/policy.ts";
import { deliveryInstructions, policyPda, type Harness } from "./program.ts";

export interface CrankOptions {
  privateKey: Uint8Array;
  attesterPublicKey: Uint8Array;
  crank: TransactionSigner;
  source: ArrivalSource;
  now: bigint;
  send: (instructions: Instruction[]) => Promise<unknown>;
}

export interface CrankResult {
  /** Policy ids this run settled. */
  settled: bigint[];
  /** Live policies left alone, with why. */
  skipped: { policyId: bigint; reason: "immature" | "no-arrival" | "other-pool" }[];
  /** Policies this run tried and could not settle, with the error. */
  failed: { policyId: bigint; error: string }[];
}

export async function settleMaturedPolicies(
  h: Harness,
  opts: CrankOptions,
): Promise<CrankResult> {
  const discriminator = getBase58Decoder().decode(POLICY_DISCRIMINATOR);
  const accounts = await h.client.rpc
    .getProgramAccounts(h.programId, {
      encoding: "base64",
      filters: [{ memcmp: { offset: 0n, bytes: discriminator, encoding: "base58" } }],
    })
    .send();

  const settled: bigint[] = [];
  const skipped: CrankResult["skipped"] = [];
  const failed: CrankResult["failed"] = [];

  for (const { pubkey, account } of accounts) {
    const [data] = account.data;
    const policy = getPolicyDecoder().decode(
      Uint8Array.from(Buffer.from(data, "base64")),
    );

    // One program, many pools: keep only this pool's policies by re-deriving the
    // PDA. The seeds are the only link — the pool is not a field on the policy.
    const expected = await policyPda(h.programId, h.config, policy.policyId);
    if (expected !== pubkey) {
      skipped.push({ policyId: policy.policyId, reason: "other-pool" });
      continue;
    }

    const deadline = policy.expectedDelivery + policy.gracePeriod;
    if (opts.now < deadline) {
      skipped.push({ policyId: policy.policyId, reason: "immature" });
      continue;
    }

    let arrival;
    try {
      arrival = await opts.source.fetch(policy.shipmentId);
    } catch (error) {
      failed.push({ policyId: policy.policyId, error: String(error) });
      continue;
    }
    if (!arrival) {
      skipped.push({ policyId: policy.policyId, reason: "no-arrival" });
      continue;
    }

    try {
      const { instructions } = await deliveryInstructions(h, {
        privateKey: opts.privateKey,
        publicKey: opts.attesterPublicKey,
        shipmentId: policy.shipmentId,
        actualDelivery: arrival.actualDelivery,
        terminalCode: arrival.terminalCode,
        nonce: policy.policyId,
        crank: opts.crank,
        insured: policy.insured,
      });
      await opts.send(instructions);
      settled.push(policy.policyId);
    } catch (error) {
      // Another crank may have settled it after our scan. Record and keep going:
      // one bad policy must not strand every later policy's capital.
      failed.push({ policyId: policy.policyId, error: String(error) });
    }
  }

  return { settled, skipped, failed };
}
