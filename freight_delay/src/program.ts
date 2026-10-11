/**
 * Hand-encoded Anchor client for freight_delay (CHA-31).
 *
 * No IDL coder on purpose: the registry is `@solana/kit`, and Anchor
 * instruction data is a discriminator followed by Borsh args — a few lines to
 * write directly. Discriminators come from `target/idl/freight_delay.json` and
 * change only when the program does.
 *
 * Account data is read by offset for the same reason. Both layouts are asserted
 * against the IDL by `scripts/lifecycle.test.ts`.
 */

import {
  AccountRole,
  type AccountSignerMeta,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type ReadonlyUint8Array,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU64Encoder,
  getI64Encoder,
  getU16Encoder,
} from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";

import { encodePayload } from "../../attester/src/payload.ts";
import { signPayload } from "../../attester/src/signing.ts";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
export const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
export const INSTRUCTIONS_SYSVAR = "Sysvar1nstructions1111111111111111111111111" as Address;
export const ED25519_PROGRAM = "Ed25519SigVerify111111111111111111111111111" as Address;

const ae = getAddressEncoder();
const u64 = (v: bigint) => getU64Encoder().encode(v);
const i64 = (v: bigint) => getI64Encoder().encode(v);
const u16 = (v: number) => getU16Encoder().encode(v);
const text = (s: string) => new TextEncoder().encode(s);

export interface Harness {
  /** A Kit client (only `rpc` is used). */
  client: { rpc: any };
  programId: Address;
  admin: Address;
  usdcMint: Address;
  config: Address;
  treasury: Address;
}

// Anchor method discriminators, in IDL declaration order.
const DISC = {
  initializePool: [95, 180, 10, 172, 84, 174, 232, 40],
  depositCapital: [157, 98, 40, 41, 205, 210, 121, 253],
  buyPolicy: [0, 59, 201, 101, 183, 3, 41, 24],
  settlePolicy: [180, 234, 21, 174, 50, 214, 91, 113],
  withdrawCapital: [82, 32, 82, 118, 160, 116, 65, 104],
} as const;

const data = (disc: readonly number[], ...args: readonly ReadonlyUint8Array[]) =>
  Uint8Array.from([...disc, ...args.flatMap((a) => [...a])]);

const pda = (programId: Address, seeds: ReadonlyUint8Array[]) =>
  getProgramDerivedAddress({ programAddress: programId, seeds }).then(([a]) => a);

// ------------------------------------------------------------------ accounts

export const configPda = (programId: Address, mint: Address) =>
  pda(programId, [text("config"), ae.encode(mint)]);

export const treasuryPda = (programId: Address, config: Address) =>
  pda(programId, [text("treasury"), ae.encode(config)]);

export const lpPositionPda = (programId: Address, config: Address, lp: Address) =>
  pda(programId, [text("lp_position"), ae.encode(config), ae.encode(lp)]);

export const policyPda = (programId: Address, config: Address, policyId: bigint) =>
  pda(programId, [text("policy"), ae.encode(config), u64(policyId)]);

export const ataFor = (owner: Address, mint: Address) =>
  findAssociatedTokenPda({ owner, tokenProgram: TOKEN_PROGRAM, mint }).then(([a]) => a);

// --------------------------------------------------------------- instructions

export function initializePool(h: Harness, feeBps: number, oracleAuthority: Address): Instruction {
  return {
    programAddress: h.programId,
    accounts: [
      { address: h.admin, role: AccountRole.WRITABLE_SIGNER }, // writable + signer
      { address: h.usdcMint, role: AccountRole.READONLY },
      { address: h.config, role: AccountRole.WRITABLE },
      { address: h.treasury, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    data: data(DISC.initializePool, u16(feeBps), ae.encode(oracleAuthority)),
  };
}

export async function depositCapital(
  h: Harness,
  lp: KeyPairSigner,
  amount: bigint,
): Promise<Instruction> {
  return {
    programAddress: h.programId,
    accounts: [
      { address: lp.address, role: AccountRole.WRITABLE_SIGNER, signer: lp } as AccountSignerMeta,
      { address: h.config, role: AccountRole.WRITABLE },
      { address: h.usdcMint, role: AccountRole.READONLY },
      { address: h.treasury, role: AccountRole.WRITABLE },
      { address: await ataFor(lp.address, h.usdcMint), role: AccountRole.WRITABLE },
      { address: await lpPositionPda(h.programId, h.config, lp.address), role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    data: data(DISC.depositCapital, u64(amount)),
  };
}

export async function buyPolicy(
  h: Harness,
  insured: KeyPairSigner,
  a: {
    policyId: bigint;
    shipmentId: bigint;
    expectedDelivery: bigint;
    gracePeriod: bigint;
    payoutAmount: bigint;
    premiumAmount: bigint;
  },
): Promise<Instruction> {
  return {
    programAddress: h.programId,
    accounts: [
      { address: insured.address, role: AccountRole.WRITABLE_SIGNER, signer: insured } as AccountSignerMeta,
      { address: h.config, role: AccountRole.WRITABLE },
      { address: h.usdcMint, role: AccountRole.READONLY },
      { address: h.treasury, role: AccountRole.WRITABLE },
      { address: await ataFor(insured.address, h.usdcMint), role: AccountRole.WRITABLE },
      { address: await policyPda(h.programId, h.config, a.policyId), role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    data: data(
      DISC.buyPolicy,
      u64(a.policyId),
      u64(a.shipmentId),
      i64(a.expectedDelivery),
      i64(a.gracePeriod),
      u64(a.payoutAmount),
      u64(a.premiumAmount),
    ),
  };
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
    crank: Address;
    insured: Address;
    policyId: bigint;
    message: Uint8Array;
    signature: Uint8Array;
  },
): Promise<Instruction> {
  return {
    programAddress: h.programId,
    accounts: [
      { address: a.crank, role: AccountRole.WRITABLE_SIGNER },
      { address: h.config, role: AccountRole.WRITABLE },
      { address: h.usdcMint, role: AccountRole.READONLY },
      { address: h.treasury, role: AccountRole.WRITABLE },
      { address: await policyPda(h.programId, h.config, a.policyId), role: AccountRole.WRITABLE },
      { address: await ataFor(a.insured, h.usdcMint), role: AccountRole.WRITABLE },
      { address: INSTRUCTIONS_SYSVAR, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
    ],
    data: data(DISC.settlePolicy, a.message, a.signature),
  };
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
    crank: Address;
    insured: Address;
  },
): Promise<{ instructions: Instruction[]; message: Uint8Array; signature: Uint8Array }> {
  const payload = {
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

// ------------------------------------------------------------------- reading

// Byte offsets into account data: 8-byte discriminator then the fields, in
// struct order (see state.rs). Asserted against the IDL in
// scripts/lifecycle.test.ts.
const OFF = {
  poolConfig: {
    // admin, oracle_authority, usdc_mint, treasury — 4 Pubkeys
    totalCapital: 8 + 32 * 4,
    totalLockedRisk: 8 + 32 * 4 + 8,
    totalShares: 8 + 32 * 4 + 16,
    totalFees: 8 + 32 * 4 + 24,
    feeBps: 8 + 32 * 4 + 32,
  },
  policy: {
    // insured(32) policy_id(8) shipment_id(8) expected_delivery(8)
    // grace_period(8) payout_amount(8) premium_amount(8)
    isSettled: 8 + 32 + 8 * 6,
    isPaid: 8 + 32 + 8 * 6 + 1,
  },
} as const;

async function bytesAt(h: Harness, addr: Address): Promise<DataView> {
  const res: any = await h.client.rpc.getAccountInfo(addr, { encoding: "base64" }).send();
  if (!res.value) throw new Error(`account not found: ${addr}`);
  const bytes = Uint8Array.from(atob(res.value.data[0]), (c) => c.charCodeAt(0));
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export async function readPool(h: Harness) {
  const v = await bytesAt(h, h.config);
  return {
    totalCapital: v.getBigUint64(OFF.poolConfig.totalCapital, true),
    totalLockedRisk: v.getBigUint64(OFF.poolConfig.totalLockedRisk, true),
    totalShares: v.getBigUint64(OFF.poolConfig.totalShares, true),
    totalFees: v.getBigUint64(OFF.poolConfig.totalFees, true),
    feeBps: v.getUint16(OFF.poolConfig.feeBps, true),
  };
}

export async function readPolicy(h: Harness, policyId: bigint) {
  const v = await bytesAt(h, await policyPda(h.programId, h.config, policyId));
  return {
    isSettled: v.getUint8(OFF.policy.isSettled) === 1,
    isPaid: v.getUint8(OFF.policy.isPaid) === 1,
  };
}
