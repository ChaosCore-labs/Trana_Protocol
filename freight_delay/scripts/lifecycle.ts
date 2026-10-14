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

import { createClient, address, createKeyPairSignerFromPrivateKeyBytes, flattenInstructionPlan, generateKeyPairSigner, getBase58Decoder } from "@solana/kit";
import { surfpool } from "@solana/surfpool/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import { SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import { TOKEN_PROGRAM_ADDRESS, getInitializeMintInstruction, getMintToATAInstructionPlanAsync } from "@solana-program/token";

import { privateKeyFromSeed, publicKeyFromPrivate } from "../../attester/src/signing.ts";
import { SimulatedSource } from "../../attester/src/simulated-source.ts";
import { settleMaturedPolicies } from "../client/crank.ts";
import {
  ataFor,
  buyPolicy,
  configPda,
  deliveryInstructions,
  depositCapital,
  getQuote,
  initializePool,
  policyPda,
  postRoot,
  readPool,
  registryPda,
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
/** `Pubkey::default()`: an open quote, acceptable by any buyer. */
const OPEN_BUYER = address("11111111111111111111111111111111");

// Fixed seed, so every run is reproducible. The pool is initialised with the
// matching public key, so changing this changes the oracle.
const ATTESTER_KEY = privateKeyFromSeed(new Uint8Array(32).fill(7));
const ATTESTER_PUBKEY = publicKeyFromPrivate(ATTESTER_KEY);
const ATTESTER_ADDRESS = address(getBase58Decoder().decode(ATTESTER_PUBKEY));
// The pool's address includes the attester's key, so the attester signs its
// creation and no one else can create — or squat — this pool.
const attester = await createKeyPairSignerFromPrivateKeyBytes(ATTESTER_KEY);

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
    .getAccountInfo(SYSVAR_CLOCK_ADDRESS, { encoding: "jsonParsed" })
    .send();
  return BigInt(res.value.data.parsed.info.unixTimestamp);
};

const admin = client.payer;
const lp = await generateKeyPairSigner();
const shipper = await generateKeyPairSigner();
client.surfnet.fundSol(lp.address, 10_000_000_000);
client.surfnet.fundSol(shipper.address, 10_000_000_000);

const usdcMint = await generateKeyPairSigner();
const config = await configPda(programId, usdcMint.address, ATTESTER_ADDRESS);
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
await client.sendTransaction([initializePool(h, FEE_BPS, attester, admin.address, admin.address)]);
let pool = await readPool(h);
report("after initialize_pool", pool);
check(`fee_bps = ${pool.feeBps}`, pool.feeBps === FEE_BPS);
check("capital 0", pool.totalCapital === 0n);
check("oracle_authority is the attester", pool.oracleAuthority === ATTESTER_ADDRESS);

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

const buy = async (policyId: bigint) => [
  await getQuote(h, admin, {
    quoteId: policyId,
    shipmentId: 27n,
    expectedDelivery,
    gracePeriod: BigInt(GRACE),
    payoutAmount: PAYOUT,
    premiumAmount: PREMIUM,
    buyer: OPEN_BUYER,
    expiresAt: expectedDelivery,
  }),
  await buyPolicy(h, shipper, { policyId, quoteId: policyId }),
];

await client.sendTransaction(await buy(1n));
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
  const buyNow = async (policyId: bigint) => [
    await getQuote(h, admin, {
      quoteId: policyId,
      shipmentId: 27n,
      expectedDelivery: quoted,
      gracePeriod: BigInt(GRACE),
      payoutAmount: PAYOUT,
      premiumAmount: PREMIUM,
      buyer: OPEN_BUYER,
      expiresAt: quoted,
    }),
    await buyPolicy(h, shipper, { policyId, quoteId: policyId }),
  ];

  await client.sendTransaction(await buyNow(s.id));
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
  // Settlement closes the policy PDA: the account is gone, and the terminal
  // record lives in the PolicyClosed event (CHA-18).
  const closed = await client.rpc
    .getAccountInfo(await policyPda(h.programId, h.config, s.id))
    .send();

  console.log(`  arrival ${iso(arrival)} (deadline ${iso(due)}, ${s.offset > 0 ? "+" : ""}${s.offset / DAY}d)`);
  report("after settle_policy", after);
  check("policy closed", closed.value === null);
  check("lock released", after.totalLockedRisk === before.totalLockedRisk - PAYOUT);
  check(
    s.pays ? "capital debited by the payout" : "capital unchanged",
    s.pays ? after.totalCapital === before.totalCapital - PAYOUT : after.totalCapital === before.totalCapital,
  );
}

// -------------------------------------------------------------------- stage 4

console.log("\nstage 4 — crank settles the remaining matured policy");
// Policy 1 was bought in stage 3 and never settled. The crank finds it by
// scanning, asks the source for its arrival, and settles it on time — no manual
// instruction. The clock is already past its deadline: the scenarios above
// advanced it, and time travel is forward-only.
const openBefore = await readPool(h);
const source = new SimulatedSource({
  arrivals: {
    "27": { actualDelivery: expectedDelivery - BigInt(DAY), terminalCode: 4201n },
  },
});
const { settled, skipped, failed } = await settleMaturedPolicies(h, {
  privateKey: ATTESTER_KEY,
  attesterPublicKey: ATTESTER_PUBKEY,
  crank: admin,
  source,
  now: await chainNow(),
  send: (ixs) => client.sendTransaction(ixs),
});
check(`crank settled [${settled.join(", ")}]`, settled.length === 1 && settled[0] === 1n);
check(
  "crank skipped only unsettleable policies",
  skipped.every((s) => s.reason === "immature" || s.reason === "no-arrival"),
);
check("crank had no failures", failed.length === 0);
const openAfter = await readPool(h);
report("after the crank", openAfter);
check("lock released", openAfter.totalLockedRisk === openBefore.totalLockedRisk - PAYOUT);
check("no payout", openAfter.totalCapital === openBefore.totalCapital);

const free = openAfter.totalCapital - openAfter.totalLockedRisk;
check(`no risk outstanding — free ${usdc(free)} equals total capital`, free === openAfter.totalCapital);

console.log("\nstage 5 — keeper posts a history-batch root");
// Placeholder root: the real Merkle batching over the closed policies lands
// with the keeper service (CHA-19). This exercises the on-chain Registry path.
const root = new Uint8Array(32).fill(0xab);
await client.sendTransaction([await postRoot(h, admin, 1n, root, 3n)]);
const registry = await client.rpc
  .getAccountInfo(await registryPda(programId, config, 1n))
  .send();
check("registry posted", registry.value !== null);

console.log(failures === 0 ? "\n✓ all checks passed" : `\n✗ ${failures} check(s) FAILED`);
client.surfnet.stop();
process.exit(failures === 0 ? 0 : 1);
