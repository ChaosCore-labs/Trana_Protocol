/**
 * Lifecycle harness for freight_delay (CHA-31).
 *
 * Instruction builders, PDAs and account codecs come from the Codama client in
 * `src/generated` — regenerate with `anchor build && bun run codegen`. This file
 * adds only what the IDL cannot describe: the ed25519 precompile instruction
 * `settle_policy` scans for.
 */

import { getAddressEncoder, type Address, type Instruction, type KeyPairSigner, type TransactionSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token";
import { SYSVAR_INSTRUCTIONS_ADDRESS } from "@solana/sysvars";

import { encodePayload } from "../../attester/src/payload.ts";
import { signPayload } from "../../attester/src/signing.ts";
import {
  fetchPolicy,
  fetchPoolConfig,
  fetchQuote,
  findConfigPda,
  findLpPositionPda,
  findPolicyPda,
  findQuotePda,
  findRegistryPda,
  findTreasuryPda,
  getBuyPolicyInstruction,
  getDepositCapitalInstruction,
  getGetQuoteInstruction,
  getInitializePoolInstruction,
  getPostRootInstruction,
  getSettlePolicyInstruction,
} from "./generated/index.ts";

/** The ed25519 precompile id — the only address the ecosystem ships no package for. */
const ED25519_PROGRAM = "Ed25519SigVerify111111111111111111111111111" as Address;

export interface Harness {
  /** A Kit client (only `rpc` is used). */
  client: { rpc: any };
  programId: Address;
  admin: TransactionSigner;
  usdcMint: Address;
  config: Address;
  treasury: Address;
}

const forProgram = (h: Harness) => ({ programAddress: h.programId });

/** The pool is identified by its mint and its attester, so both seed the PDA. */
export const configPda = (programId: Address, mint: Address, oracleAuthority: Address) =>
  findConfigPda({ usdcMint: mint, oracleAuthority }, { programAddress: programId }).then(([a]) => a);

export const treasuryPda = (programId: Address, config: Address) =>
  findTreasuryPda({ config }, { programAddress: programId }).then(([a]) => a);

export const lpPositionPda = (programId: Address, config: Address, lp: Address) =>
  findLpPositionPda({ config, lp }, { programAddress: programId }).then(([a]) => a);

export const policyPda = (programId: Address, config: Address, policyId: bigint) =>
  findPolicyPda({ config, policyId }, { programAddress: programId }).then(([a]) => a);

export const quotePda = (programId: Address, config: Address, quoteId: bigint) =>
  findQuotePda({ config, quoteId }, { programAddress: programId }).then(([a]) => a);

export const ataFor = (owner: Address, mint: Address) =>
  findAssociatedTokenPda({ owner, tokenProgram: TOKEN_PROGRAM_ADDRESS, mint }).then(([a]) => a);

/**
 * Create the pool. The attester signs: its key is part of the pool's address, so
 * nobody else can create — or squat — the pool that belongs to it.
 */
export function initializePool(
  h: Harness,
  feeBps: number,
  oracleAuthority: TransactionSigner,
  keeper: Address,
  underwriter: Address,
): Instruction {
  return getInitializePoolInstruction(
    {
      admin: h.admin,
      usdcMint: h.usdcMint,
      oracleAuthority,
      config: h.config,
      treasury: h.treasury,
      feeBps,
      keeper,
      underwriter,
    },
    forProgram(h),
  );
}

export async function depositCapital(
  h: Harness,
  lp: KeyPairSigner,
  amount: bigint,
): Promise<Instruction> {
  return getDepositCapitalInstruction(
    {
      lp,
      config: h.config,
      usdcMint: h.usdcMint,
      treasury: h.treasury,
      lpUsdc: await ataFor(lp.address, h.usdcMint),
      lpPosition: await lpPositionPda(h.programId, h.config, lp.address),
      amount,
    },
    forProgram(h),
  );
}

/**
 * Author terms as the pool's underwriter. `buyer` of the default address is an
 * open quote any buyer may accept; the premium is the seller's number, never the
 * caller of `buy_policy`.
 */
export async function getQuote(
  h: Harness,
  underwriter: TransactionSigner,
  a: {
    quoteId: bigint;
    shipmentId: bigint;
    expectedDelivery: bigint;
    gracePeriod: bigint;
    payoutAmount: bigint;
    premiumAmount: bigint;
    buyer: Address;
    expiresAt: bigint;
  },
): Promise<Instruction> {
  return getGetQuoteInstruction(
    {
      underwriter,
      config: h.config,
      quote: await quotePda(h.programId, h.config, a.quoteId),
      quoteId: a.quoteId,
      shipmentId: a.shipmentId,
      expectedDelivery: a.expectedDelivery,
      gracePeriod: a.gracePeriod,
      payoutAmount: a.payoutAmount,
      premiumAmount: a.premiumAmount,
      buyer: a.buyer,
      expiresAt: a.expiresAt,
    },
    forProgram(h),
  );
}

export async function buyPolicy(
  h: Harness,
  insured: KeyPairSigner,
  a: {
    policyId: bigint;
    quoteId: bigint;
  },
): Promise<Instruction> {
  return getBuyPolicyInstruction(
    {
      insured,
      config: h.config,
      usdcMint: h.usdcMint,
      treasury: h.treasury,
      insuredUsdc: await ataFor(insured.address, h.usdcMint),
      quote: await quotePda(h.programId, h.config, a.quoteId),
      policy: await policyPda(h.programId, h.config, a.policyId),
      policyId: a.policyId,
      quoteId: a.quoteId,
    },
    forProgram(h),
  );
}

/**
 * The ed25519 precompile instruction, inline payload.
 *
 * Layout matches what `shared.rs::ed25519_ix_matches` parses: a 16-byte header
 * of u16 LE offsets, all pointing inside this instruction (index 0xFFFF), then
 * the public key, signature and message.
 */
export function ed25519Precompile(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): Instruction {
  const header = 16;
  const pkOff = header;
  const sigOff = pkOff + 32;
  const msgOff = sigOff + 64;
  const put = (v: number) => [v & 0xff, (v >> 8) & 0xff];

  const payload = [
    1,
    0,
    ...put(sigOff),
    ...put(0xffff),
    ...put(pkOff),
    ...put(0xffff),
    ...put(msgOff),
    ...put(message.length),
    ...put(0xffff),
    ...publicKey,
    ...signature,
    ...message,
  ];
  return { programAddress: ED25519_PROGRAM, accounts: [], data: Uint8Array.from(payload) };
}

export async function settlePolicy(
  h: Harness,
  a: {
    crank: TransactionSigner;
    insured: Address;
    policyId: bigint;
    message: Uint8Array;
    signature: Uint8Array;
  },
): Promise<Instruction> {
  const [shipmentId, actualDelivery, terminalCode, nonce] = attestationFields(a.message);
  return getSettlePolicyInstruction(
    {
      crank: a.crank,
      config: h.config,
      usdcMint: h.usdcMint,
      treasury: h.treasury,
      policy: await policyPda(h.programId, h.config, a.policyId),
      insured: a.insured,
      insuredUsdc: await ataFor(a.insured, h.usdcMint),
      instructions: SYSVAR_INSTRUCTIONS_ADDRESS,
      shipmentId,
      actualDelivery,
      terminalCode,
      nonce,
      signature: a.signature,
    },
    forProgram(h),
  );
}

/** The delivery fields, read past the 32-byte pool prefix. */
function attestationFields(message: Uint8Array): [bigint, bigint, bigint, bigint] {
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  return [
    view.getBigUint64(32, true),
    view.getBigInt64(40, true),
    view.getBigUint64(48, true),
    view.getBigUint64(56, true),
  ];
}

/**
 * The instruction pair that settles a policy from a signed arrival: the
 * ed25519 precompile first, then `settle_policy`. The program scans only the
 * instructions before it.
 */
export async function deliveryInstructions(
  h: Harness,
  a: {
    privateKey: Uint8Array;
    publicKey: Uint8Array;
    shipmentId: bigint;
    actualDelivery: bigint;
    terminalCode: bigint;
    nonce: bigint;
    crank: TransactionSigner;
    insured: Address;
  },
): Promise<{ instructions: Instruction[]; message: Uint8Array; signature: Uint8Array }> {
  const payload = {
    pool: Uint8Array.from(getAddressEncoder().encode(h.config)),
    shipmentId: a.shipmentId,
    actualDelivery: a.actualDelivery,
    terminalCode: a.terminalCode,
    nonce: a.nonce,
  };
  const message = encodePayload(payload);
  const signature = signPayload(payload, a.privateKey);

  const precompile = ed25519Precompile(message, signature, a.publicKey);
  const settle = await settlePolicy(h, {
    crank: a.crank,
    insured: a.insured,
    policyId: a.nonce,
    message,
    signature,
  });
  return { instructions: [precompile, settle], message, signature };
}

export const registryPda = (programId: Address, config: Address, epoch: bigint) =>
  findRegistryPda({ config, epoch }, { programAddress: programId }).then(([a]) => a);

export async function postRoot(
  h: Harness,
  keeper: TransactionSigner,
  epoch: bigint,
  root: Uint8Array,
  count: bigint,
): Promise<Instruction> {
  return getPostRootInstruction(
    {
      keeper,
      config: h.config,
      registry: await registryPda(h.programId, h.config, epoch),
      epoch,
      root,
      count,
    },
    forProgram(h),
  );
}

export async function readPool(h: Harness) {
  const { data } = await fetchPoolConfig(h.client.rpc, h.config);
  return data;
}

export async function readPolicy(h: Harness, policyId: bigint) {
  const { data } = await fetchPolicy(h.client.rpc, await policyPda(h.programId, h.config, policyId));
  return data;
}

export async function readQuote(h: Harness, quoteId: bigint) {
  const { data } = await fetchQuote(h.client.rpc, await quotePda(h.programId, h.config, quoteId));
  return data;
}
