#!/usr/bin/env bun
/**
 * Local MVP walkthrough (CHA-31).
 *
 * Drives the whole protocol against an embedded Surfnet and prints the state
 * transitions. `get_quote` authors the terms — payout, premium, fee — and
 * `buy_policy` accepts them; then two cases, an on-time arrival that releases
 * the lock and a late one that pays.
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
  lpPositionPda,
  policyPda,
  postRoot,
  readPool,
  readTokenBalance,
  registryPda,
  treasuryPda,
  withdrawCapital,
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
const PREMIUM = 2_000n * USDC;
/** Delay cover pays a high multiple of the premium: 15×. */
const PAYOUT = 15n * PREMIUM;
/** The pool keeps this share of every premium; the rest is credited to capital. */
const FEE_AMOUNT = (PREMIUM * BigInt(FEE_BPS)) / 10_000n;
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

// ANSI colour, no dependency. Off when stdout is not a terminal (or NO_COLOR is
// set), so piped output stays plain.
const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const paint = (code: number, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => paint(2, s);
const bold = (s: string) => paint(1, s);
const green = (s: string) => paint(32, s);
const red = (s: string) => paint(31, s);
const cyan = (s: string) => paint(36, s);
const yellow = (s: string) => paint(33, s);

let failures = 0;
const check = (label: string, ok: boolean) => {
  console.log(`    ${ok ? green("ok  ") : red("FAIL")}  ${label}`);
  if (!ok) failures++;
};
const usdc = (v: bigint) =>
  `${(Number(v) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2 })} USDC`;
const iso = (s: bigint | number) => new Date(Number(s) * 1000).toISOString().slice(0, 10);

function report(label: string, pool: Awaited<ReturnType<typeof readPool>>) {
  console.log(`  ${bold(cyan(label))}`);
  const row = (name: string, value: string) => console.log(`    ${dim(name.padEnd(19))}${value.padStart(16)}`);
  row("total_capital", usdc(pool.totalCapital));
  row("total_locked_risk", usdc(pool.totalLockedRisk));
  row("free_capital", usdc(pool.totalCapital - pool.totalLockedRisk));
  row("total_fees", usdc(pool.totalFees));
}

const stage = (title: string) => console.log(`\n${bold(cyan(title))}`);

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

console.log(`${dim("program")}   ${programId}`);
console.log(`${dim("rpc")}       ${client.rpcUrl}`);
console.log(`${dim("payer")}     ${admin.address}`);

// -------------------------------------------------------------------- stage 0

stage("stage 0 — test USDC mint");
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
// so both are minted through it. The shipper pays one premium per policy it
// buys, so it is funded for four.
for (const [who, amount] of [
  [lp, 3_000_000n * USDC],
  [shipper, 4n * PREMIUM],
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

stage("stage 1 — initialize_pool");
await client.sendTransaction([initializePool(h, FEE_BPS, attester, admin.address, admin.address)]);
let pool = await readPool(h);
report("after initialize_pool", pool);
check(`fee_bps = ${pool.feeBps}`, pool.feeBps === FEE_BPS);
check("capital 0", pool.totalCapital === 0n);
check("oracle_authority is the attester", pool.oracleAuthority === ATTESTER_ADDRESS);

// -------------------------------------------------------------------- stage 2

stage("stage 2 — deposit_capital");
await client.sendTransaction([await depositCapital(h, lp, DEPOSIT)]);
pool = await readPool(h);
report("after deposit_capital", pool);
check("capital equals deposit", pool.totalCapital === DEPOSIT);
check("shares minted 1:1", pool.totalShares === DEPOSIT);

// -------------------------------------------------------------------- stage 3

stage("stage 3 — get_quote + buy_policy");
const expectedDelivery = (await chainNow()) + BigInt(QUOTED_TRANSIT);
const deadline = expectedDelivery + BigInt(GRACE);

/** `get_quote` then `buy_policy`: the underwriter authors the terms, the buyer accepts them. */
const quoteAndBuy = async (policyId: bigint, expected: bigint) => [
  await getQuote(h, admin, {
    quoteId: policyId,
    shipmentId: 27n,
    expectedDelivery: expected,
    gracePeriod: BigInt(GRACE),
    payoutAmount: PAYOUT,
    premiumAmount: PREMIUM,
    buyer: OPEN_BUYER,
    expiresAt: expected,
  }),
  await buyPolicy(h, shipper, { policyId, quoteId: policyId }),
];

const announce = (policyId: bigint, expected: bigint) => {
  console.log(`  ${bold("get_quote")}   quote ${policyId}: payout ${usdc(PAYOUT)}, premium ${usdc(PREMIUM)}, fee ${FEE_BPS / 100}% (${usdc(FEE_AMOUNT)})`);
  console.log(`  ${bold("buy_policy")}  policy ${policyId}: ${usdc(PAYOUT)} locked, ${usdc(PREMIUM)} premium paid by the shipper`);
  console.log(`  ${dim(`deadline     ${iso(expected + BigInt(GRACE))} (quoted ${iso(expected)} + ${GRACE / DAY}d grace)`)}`);
};

await client.sendTransaction(await quoteAndBuy(1n, expectedDelivery));
announce(1n, expectedDelivery);
pool = await readPool(h);
report("after buy_policy", pool);
check(`payout locked ${usdc(PAYOUT)}`, pool.totalLockedRisk === PAYOUT);
check(`premium credited net of ${FEE_BPS}bps fee`, pool.totalFees === FEE_AMOUNT);

// -------------------------------------------------------------- case a: on time

console.log(`\n${bold(yellow("case a — the shipment is not late → no payout"))}`);
// Policy 1 is the one bought in stage 3, so this case settles it: on an on-time
// arrival the pool releases the whole lock and nothing leaves the treasury.
const onTimeArrival = expectedDelivery - BigInt(DAY);
// Move the runtime clock past the deadline. This writes the Clock sysvar, so
// `settle_policy`'s maturity gate sees it.
client.surfnet.timeTravelToTimestamp((Number(deadline) + DAY) * 1000);
await client.sendTransaction(
  (await deliveryInstructions(h, {
    privateKey: ATTESTER_KEY,
    publicKey: ATTESTER_PUBKEY,
    shipmentId: 27n,
    actualDelivery: onTimeArrival,
    terminalCode: 4201n,
    nonce: 1n,
    crank: admin,
    insured: shipper.address,
  })).instructions,
);
const afterOnTime = await readPool(h);
// Settlement closes the policy PDA: the account is gone, and the terminal
// record lives in the PolicyClosed event (CHA-18).
const closedOnTime = await client.rpc
  .getAccountInfo(await policyPda(h.programId, h.config, 1n))
  .send();
console.log(dim(`  arrival ${iso(onTimeArrival)} (deadline ${iso(deadline)}, on time)`));
report("after settle_policy", afterOnTime);
check("policy closed", closedOnTime.value === null);
check("lock released — no risk outstanding", afterOnTime.totalLockedRisk === 0n);
check("capital unchanged", afterOnTime.totalCapital === pool.totalCapital);
check(
  `whole capital is free — ${usdc(afterOnTime.totalCapital)}`,
  afterOnTime.totalCapital - afterOnTime.totalLockedRisk === afterOnTime.totalCapital,
);

// ----------------------------------------------------------------- case b: late

console.log(`\n${bold(yellow("case b — the shipment is late → payout"))}`);
// A fresh policy, quoted from the current chain time, then an arrival five days
// past its deadline.
const lateQuoted = (await chainNow()) + BigInt(QUOTED_TRANSIT);
const lateDue = lateQuoted + BigInt(GRACE);
await client.sendTransaction(await quoteAndBuy(2n, lateQuoted));
announce(2n, lateQuoted);
const beforeLate = await readPool(h);
client.surfnet.timeTravelToTimestamp((Number(lateDue) + DAY) * 1000);
const lateArrival = lateDue + 5n * BigInt(DAY);
await client.sendTransaction(
  (await deliveryInstructions(h, {
    privateKey: ATTESTER_KEY,
    publicKey: ATTESTER_PUBKEY,
    shipmentId: 27n,
    actualDelivery: lateArrival,
    terminalCode: 4201n,
    nonce: 2n,
    crank: admin,
    insured: shipper.address,
  })).instructions,
);
const afterLate = await readPool(h);
const closedLate = await client.rpc
  .getAccountInfo(await policyPda(h.programId, h.config, 2n))
  .send();
console.log(dim(`  arrival ${iso(lateArrival)} (deadline ${iso(lateDue)}, +5d late)`));
report("after settle_policy", afterLate);
check("policy closed", closedLate.value === null);
check("lock released", afterLate.totalLockedRisk === beforeLate.totalLockedRisk - PAYOUT);
check(`capital debited by the payout ${usdc(PAYOUT)}`, afterLate.totalCapital === beforeLate.totalCapital - PAYOUT);

// -------------------------------------------------------------------- stage 4

stage("stage 4 — the crank settles a matured policy");
// A third policy, bought and then matured by time travel. The crank finds it by
// scanning, asks the source for its arrival, and settles it on time — no manual
// instruction, and no payout.
const crankQuoted = (await chainNow()) + BigInt(QUOTED_TRANSIT);
const crankDue = crankQuoted + BigInt(GRACE);
await client.sendTransaction(await quoteAndBuy(3n, crankQuoted));
announce(3n, crankQuoted);
const openBefore = await readPool(h);
client.surfnet.timeTravelToTimestamp((Number(crankDue) + DAY) * 1000);
const source = new SimulatedSource({
  arrivals: {
    "27": { actualDelivery: crankQuoted - BigInt(DAY), terminalCode: 4201n },
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
check(`crank settled [${settled.join(", ")}]`, settled.length === 1 && settled[0] === 3n);
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

stage("stage 5 — keeper posts a history-batch root");
// Placeholder root: the real Merkle batching over the closed policies lands
// with the keeper service (CHA-19). This exercises the on-chain Registry path.
const root = new Uint8Array(32).fill(0xab);
await client.sendTransaction([await postRoot(h, admin, 1n, root, 3n)]);
const registry = await client.rpc
  .getAccountInfo(await registryPda(programId, config, 1n))
  .send();
check("registry posted", registry.value !== null);

// -------------------------------------------------------------------- stage 6

stage("stage 6 — withdraw_capital");
// The LP redeems in two calls: half the shares, then the rest. Shares redeem at
// the pool's current capital per share, so the premiums earned — and the payout
// paid out of capital — are priced in. The second call burns the last share.
const beforeExit = await readPool(h);
const treasuryBeforeExit = await readTokenBalance(h, treasury);
const lpUsdc = await ataFor(lp.address, usdcMint.address);
const lpBeforeExit = await readTokenBalance(h, lpUsdc);

const half = beforeExit.totalShares / 2n;
const remainingShares = beforeExit.totalShares - half;
// Same floor as the program: shares * total_capital / total_shares.
const expectedFirst = (half * beforeExit.totalCapital) / beforeExit.totalShares;

await client.sendTransaction([await withdrawCapital(h, lp, half)]);
const afterHalf = await readPool(h);
report("after withdraw_capital (half the shares)", afterHalf);
check(
  `capital debited by ${usdc(expectedFirst)}`,
  afterHalf.totalCapital === beforeExit.totalCapital - expectedFirst,
);
check(`shares burned — ${usdc(remainingShares)} left`, afterHalf.totalShares === remainingShares);
const stillInvested = await client.rpc
  .getAccountInfo(await lpPositionPda(programId, config, lp.address))
  .send();
check("position still open", stillInvested.value !== null);

await client.sendTransaction([await withdrawCapital(h, lp, remainingShares)]);
const afterExit = await readPool(h);
report("after withdraw_capital (the rest)", afterExit);
check("pool emptied — capital and shares 0", afterExit.totalCapital === 0n && afterExit.totalShares === 0n);
const positionGone = await client.rpc
  .getAccountInfo(await lpPositionPda(programId, config, lp.address))
  .send();
check("position closed, rent returned", positionGone.value === null);
const treasuryAfterExit = await readTokenBalance(h, treasury);
const lpAfterExit = await readTokenBalance(h, lpUsdc);
check(
  `treasury paid out ${usdc(treasuryBeforeExit - treasuryAfterExit)}`,
  treasuryBeforeExit - treasuryAfterExit === beforeExit.totalCapital,
);
check(
  `LP received ${usdc(lpAfterExit - lpBeforeExit)}`,
  lpAfterExit - lpBeforeExit === beforeExit.totalCapital,
);
console.log(
  dim(`  LP deposited ${usdc(DEPOSIT)} and redeemed ${usdc(beforeExit.totalCapital)}`),
);

console.log(
  failures === 0 ? `\n${bold(green("✓ all checks passed"))}` : `\n${bold(red(`✗ ${failures} check(s) FAILED`))}`,
);
client.surfnet.stop();
process.exit(failures === 0 ? 0 : 1);
