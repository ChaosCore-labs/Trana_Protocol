#!/usr/bin/env bun
/**
 * Local MVP walkthrough (CHA-31).
 *
 * Drives the whole protocol against an embedded Surfnet and prints the state
 * transitions. Two scenarios: a late arrival that pays, and an on-time arrival
 * that does not.
 *
 *   anchor build && bun run lifecycle
 *
 * The attester is the real one: `attester/src/` encodes and signs the arrival
 * payload, and the same signature would be accepted on any cluster.
 */

import { createClient, address, flattenInstructionPlan, generateKeyPairSigner, getBase58Decoder } from "@solana/kit";
import { surfpool } from "@solana/surfpool/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import { TOKEN_PROGRAM_ADDRESS, getInitializeMintInstruction, getMintToATAInstructionPlanAsync } from "@solana-program/token";

import { privateKeyFromSeed, publicKeyFromPrivate } from "../../attester/src/signing.ts";
import {
  ataFor,
  buyPolicy,
  configPda,
  deliveryInstructions,
  depositCapital,
  initializePool,
  readPolicy,
  readPool,
  treasuryPda,
  type Harness,
} from "../client/program.ts";

const PROGRAM_NAME = "freight_delay";
const DECIMALS = 6;
const FEE_BPS = 200;
const DAY = 24 * 60 * 60;
const USDC = 1_000_000n;

const QUOTED_TRANSIT = 30 * DAY;
const GRACE = 3 * DAY;
const DEPOSIT = 2_000_000n * USDC;
const PAYOUT = 500_000n * USDC;
const PREMIUM = 50_000n * USDC;

// Fixed seed, so every run is reproducible. The pool is initialised with the
// matching public key, so changing this changes the oracle.
const ATTESTER_KEY = privateKeyFromSeed(new Uint8Array(32).fill(7));
const ATTESTER_PUBKEY = publicKeyFromPrivate(ATTESTER_KEY);
const ATTESTER_ADDRESS = address(getBase58Decoder().decode(ATTESTER_PUBKEY));

let failures = 0;
const check = (label: string, ok: boolean) => {
  console.log(`    ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};
const usdc = (v: bigint) =>
  `${(Number(v) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2 })} USDC`;
const iso = (s: bigint | number) => new Date(Number(s) * 1000).toISOString().slice(0, 10);

function report(label: string, pool: Awaited<ReturnType<typeof readPool>>) {
  console.log(`  ${label}`);
  console.log(`    total_capital      ${usdc(pool.totalCapital).padStart(16)}`);
  console.log(`    total_locked_risk  ${usdc(pool.totalLockedRisk).padStart(16)}`);
  console.log(`    free_capital       ${usdc(pool.totalCapital - pool.totalLockedRisk).padStart(16)}`);
  console.log(`    total_fees         ${usdc(pool.totalFees).padStart(16)}`);
}

// ---------------------------------------------------------------------- setup

const client = await createClient().use(surfpool());
const programId = address(client.surfnet.deployProgram(PROGRAM_NAME));

/** The validator's own clock — not the host's. Surfnet starts at a fixed slot. */
const chainNow = async (): Promise<bigint> => {
  const res: any = await client.rpc
    .getAccountInfo(address("SysvarC1ock11111111111111111111111111111111"), { encoding: "jsonParsed" })
    .send();
  return BigInt(res.value.data.parsed.info.unixTimestamp);
};

const admin = client.payer;
const lp = await generateKeyPairSigner();
const shipper = await generateKeyPairSigner();
client.surfnet.fundSol(lp.address, 10_000_000_000);
client.surfnet.fundSol(shipper.address, 10_000_000_000);

const usdcMint = await generateKeyPairSigner();
const config = await configPda(programId, usdcMint.address);
const treasury = await treasuryPda(programId, config);

const h: Harness = {
  client,
  programId,
  admin,
  usdcMint: usdcMint.address,
  config,
  treasury,
};

console.log(`program   ${programId}`);
console.log(`rpc       ${client.rpcUrl}`);
console.log(`payer     ${admin.address}`);

// -------------------------------------------------------------------- stage 0

console.log("\nstage 0 — test USDC mint");
await client.sendTransaction([
  getCreateAccountInstruction({
    payer: admin,
    newAccount: usdcMint,
    lamports: 1_500_000n,
    space: 82n,
    programAddress: TOKEN_PROGRAM_ADDRESS,
  }),
  getInitializeMintInstruction({
    mint: usdcMint.address,
    decimals: DECIMALS,
    // The admin mints test USDC. The treasury's authority is the pool PDA, set
    // by the program itself, so the mint authority is unrelated to it.
    mintAuthority: admin.address,
    freezeAuthority: null,
  }),
]);
check(`mint ${usdcMint.address.slice(0, 8)}…`, true);

// Fund the LP and the shipper with USDC. On chain the pool PDA owns the mint,
// so both are minted through it.
for (const [who, amount] of [
  [lp, 3_000_000n * USDC],
  [shipper, 100_000n * USDC],
] as const) {
  const plan = await getMintToATAInstructionPlanAsync({
    payer: admin,
    owner: who.address,
    mint: usdcMint.address,
    mintAuthority: admin,
    amount,
    decimals: DECIMALS,
  });
  await client.sendTransaction(flattenInstructionPlan(plan));
}
check("USDC minted to LP and shipper", true);

// -------------------------------------------------------------------- stage 1

console.log("\nstage 1 — initialize_pool");
await client.sendTransaction([initializePool(h, FEE_BPS, ATTESTER_ADDRESS)]);
let pool = await readPool(h);
report("after initialize_pool", pool);
check(`fee_bps = ${pool.feeBps}`, pool.feeBps === FEE_BPS);
check("capital 0", pool.totalCapital === 0n);

// -------------------------------------------------------------------- stage 2

console.log("\nstage 2 — deposit_capital");
await client.sendTransaction([await depositCapital(h, lp, DEPOSIT)]);
pool = await readPool(h);
report("after deposit_capital", pool);
check("capital equals deposit", pool.totalCapital === DEPOSIT);
check("shares minted 1:1", pool.totalShares === DEPOSIT);

// -------------------------------------------------------------------- stage 3

console.log("\nstage 3 — buy_policy");
const expectedDelivery = (await chainNow()) + BigInt(QUOTED_TRANSIT);
const deadline = expectedDelivery + BigInt(GRACE);

const buy = (policyId: bigint) =>
  buyPolicy(h, shipper, {
    policyId,
    shipmentId: 27n,
    expectedDelivery,
    gracePeriod: BigInt(GRACE),
    payoutAmount: PAYOUT,
    premiumAmount: PREMIUM,
  });

await client.sendTransaction([await buy(1n)]);
pool = await readPool(h);
report("after buy_policy", pool);
check(`payout locked ${usdc(PAYOUT)}`, pool.totalLockedRisk === PAYOUT);
check(`premium credited net of ${FEE_BPS}bps fee`, pool.totalFees === (PREMIUM * BigInt(FEE_BPS)) / 10_000n);
console.log(`\n  deadline ${iso(deadline)} (quoted ${iso(expectedDelivery)} + ${GRACE / DAY}d grace)`);

// ----------------------------------------------------------------- scenarios

const scenarios = [
  { name: "late arrival → payout", id: 2n, offset: 5 * DAY, pays: true },
  { name: "on-time arrival → no payout", id: 3n, offset: -2 * DAY, pays: false },
];

for (const s of scenarios) {
  console.log(`\nscenario — ${s.name}`);

  // Each scenario re-quotes from the current chain time, because the previous
  // iteration travelled the clock forward.
  const quoted = (await chainNow()) + BigInt(QUOTED_TRANSIT);
  const due = quoted + BigInt(GRACE);
  const buyNow = (policyId: bigint) =>
    buyPolicy(h, shipper, {
      policyId,
      shipmentId: 27n,
      expectedDelivery: quoted,
      gracePeriod: BigInt(GRACE),
      payoutAmount: PAYOUT,
      premiumAmount: PREMIUM,
    });

  await client.sendTransaction([await buyNow(s.id)]);
  const before = await readPool(h);

  // Move the runtime clock past the deadline. This writes the Clock sysvar, so
  // `settle_policy`'s maturity gate sees it.
  client.surfnet.timeTravelToTimestamp((Number(due) + DAY) * 1000);
  const arrival = due + BigInt(s.offset);

  const { instructions } = await deliveryInstructions(h, {
    privateKey: ATTESTER_KEY,
    publicKey: ATTESTER_PUBKEY,
    shipmentId: 27n,
    actualDelivery: arrival,
    terminalCode: 4201n,
    nonce: s.id,
    crank: admin,
    insured: shipper.address,
  });

  await client.sendTransaction(instructions);

  const after = await readPool(h);
  const policy = await readPolicy(h, s.id);

  console.log(`  arrival ${iso(arrival)} (deadline ${iso(due)}, ${s.offset > 0 ? "+" : ""}${s.offset / DAY}d)`);
  report("after settle_policy", after);
  check("settled", policy.isSettled);
  check(`is_paid = ${s.pays}`, policy.isPaid === s.pays);
  check("lock released", after.totalLockedRisk === before.totalLockedRisk - PAYOUT);
  check(
    s.pays ? "capital debited by the payout" : "capital unchanged",
    s.pays ? after.totalCapital === before.totalCapital - PAYOUT : after.totalCapital === before.totalCapital,
  );
}

// -------------------------------------------------------------------- stage 4

console.log("\nstage 4 — release the remaining policy");
// Policy 1 was bought in stage 3 and never settled. Settling it on time
// releases its lock without paying, which is what frees the last capital.
const openBefore = await readPool(h);
// No time travel: the clock is already past policy 1's deadline, because the
// scenarios above advanced it. Time travel is forward-only.
const { instructions: onTimeIx } = await deliveryInstructions(h, {
  privateKey: ATTESTER_KEY,
  publicKey: ATTESTER_PUBKEY,
  shipmentId: 27n,
  actualDelivery: expectedDelivery - BigInt(DAY),
  terminalCode: 4201n,
  nonce: 1n,
  crank: admin,
  insured: shipper.address,
});
await client.sendTransaction(onTimeIx);
const openAfter = await readPool(h);
report("after settling policy 1", openAfter);
check("lock released", openAfter.totalLockedRisk === openBefore.totalLockedRisk - PAYOUT);
check("no payout", openAfter.totalCapital === openBefore.totalCapital);

const free = openAfter.totalCapital - openAfter.totalLockedRisk;
check(`no risk outstanding — free ${usdc(free)} equals total capital`, free === openAfter.totalCapital);

console.log(failures === 0 ? "\n✓ all checks passed" : `\n✗ ${failures} check(s) FAILED`);
client.surfnet.stop();
process.exit(failures === 0 ? 0 : 1);
