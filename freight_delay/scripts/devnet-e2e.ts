#!/usr/bin/env bun
/**
 * Devnet end-to-end proof.
 *
 * Drives the whole protocol against the program deployed on devnet and asserts
 * every outcome. The LiteSVM suite in `programs/freight_delay/tests/` proves the
 * logic in-process; this proves the *deployed* binary on a real cluster, with
 * real fees, real confirmation and the real clock — there is no time travel on
 * devnet, so each policy is quoted with a deadline seconds away and the run waits
 * for the chain clock to pass it. Two cases: an on-time arrival that releases the
 * lock, then a late one that pays.
 *
 *   anchor deploy --provider.cluster devnet
 *   bun run devnet-e2e
 *
 * The USDC in this run is demo money: a 6-decimal token the script mints for
 * itself, with no value, no faucet and no relation to Circle's USDC. Every run
 * creates a fresh mint, so no run touches anyone else's balances.
 *
 * Env: DEVNET_KEYPAIR (default `~/.config/solana/id.json`) pays for everything.
 */

import {
  address,
  createClient,
  createKeyPairSignerFromPrivateKeyBytes,
  devnet,
  flattenInstructionPlan,
  generateKeyPairSigner,
  getBase58Decoder,
  lamports,
} from "@solana/kit";
import { solanaDevnetRpc } from "@solana/kit-plugin-rpc";
import { payerFromFile } from "@solana/kit-plugin-signer";
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import { SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import {
  TOKEN_PROGRAM_ADDRESS,
  getInitializeMintInstruction,
  getMintToATAInstructionPlanAsync,
} from "@solana-program/token";

import { privateKeyFromSeed, publicKeyFromPrivate } from "../../attester/src/signing.ts";
import {
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
import { FREIGHT_DELAY_PROGRAM_ADDRESS } from "../client/generated/index.ts";

const DECIMALS = 6;
const FEE_BPS = 200;
const USDC = 1_000_000n;
/** `Pubkey::default()`: an open quote, acceptable by any buyer. */
const OPEN_BUYER = address("11111111111111111111111111111111");
const DEPOSIT = 500_000n * USDC;
/** The on-time policy is the big one; the late one is small. */
const LATE_PREMIUM = 2_000n * USDC;
const ONTIME_PREMIUM = 20_000n * USDC;
/** Delay cover pays a high multiple of the premium: 15×, as in the local walkthrough. */
const LATE_PAYOUT = 15n * LATE_PREMIUM;
const ONTIME_PAYOUT = 15n * ONTIME_PREMIUM;
/** Seconds between the quote and the deadline: devnet's clock is real time, so every
 * second here is a second the run waits for the deadline. The two sends between the
 * quote and the buy take ~4s, which has to fit inside it (`expires_at` cannot be
 * later than `expected_delivery`). */
const QUOTE_AHEAD = 10n;
/** How far the attested arrival sits either side of the deadline, within the quote ahead. */
const ARRIVAL_OFFSET = 5n;
const CLOCK_BUDGET_MS = 240_000;

const explorer = (path: string) => `https://explorer.solana.com/${path}?cluster=devnet`;

let failures = 0;
const check = (label: string, ok: boolean) => {
  console.log(`    ${ok ? green("ok  ") : red("FAIL")}  ${label}`);
  if (!ok) failures++;
};
// ANSI colour, no dependency. Off when stdout is not a terminal (or NO_COLOR is
// set), so piped output stays plain.
const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const paint = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = (t: string) => paint("32;1", t);
const red = (t: string) => paint("31;1", t);
const cyan = (t: string) => paint("36;1", t);
const yellow = (t: string) => paint("33;1", t);
const dim = (t: string) => paint("2", t);

const usdc = (v: bigint) =>
  `${(Number(v) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2 })} USDC`;

function report(label: string, pool: Awaited<ReturnType<typeof readPool>>) {
  console.log(`  ${cyan(label)}`);
  console.log(`    total_capital      ${usdc(pool.totalCapital).padStart(16)}`);
  console.log(`    total_locked_risk  ${usdc(pool.totalLockedRisk).padStart(16)}`);
  console.log(`    free_capital       ${usdc(pool.totalCapital - pool.totalLockedRisk).padStart(16)}`);
  console.log(`    total_fees         ${usdc(pool.totalFees).padStart(16)}`);
}

// ---------------------------------------------------------------------- setup

const keypairPath = process.env.DEVNET_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`;
const rpcUrl = devnet(process.env.DEVNET_RPC ?? "https://api.devnet.solana.com");
const client = await createClient()
  .use(payerFromFile(keypairPath))
  .use(solanaDevnetRpc({ rpcUrl, maxConcurrency: 1 }));

/** Sends with backoff: the public devnet RPC throttles bursts with HTTP 429, and a
 * throttled simulation surfaces as a failed compute-unit estimate. Either way nothing was
 * submitted, so a retry cannot double-apply. */
async function send(ixs: Parameters<typeof client.sendTransaction>[0]) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.sendTransaction(ixs);
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      const transient = /429|Too Many Requests|rate limit|Failed to estimate the compute unit/i;
      if (!transient.test(message) || attempt >= 8) throw e;
      const backoffMs = Math.min(20_000, 1_000 * 2 ** (attempt - 1));
      console.log(dim(`    … devnet rpc busy, retrying in ${backoffMs / 1000}s (attempt ${attempt})`));
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}
const programId = FREIGHT_DELAY_PROGRAM_ADDRESS;
const admin = client.payer;

// The attester is the real one: `attester/src/` encodes and signs the payload the
// program verifies. The seed is fixed so a re-run reuses the same oracle.
const ATTESTER_KEY = privateKeyFromSeed(new Uint8Array(32).fill(7));
const ATTESTER_PUBKEY = publicKeyFromPrivate(ATTESTER_KEY);
const ATTESTER_ADDRESS = address(getBase58Decoder().decode(ATTESTER_PUBKEY));
const attester = await createKeyPairSignerFromPrivateKeyBytes(ATTESTER_KEY);

const chainNow = async (): Promise<bigint> => {
  const res: any = await client.rpc
    .getAccountInfo(SYSVAR_CLOCK_ADDRESS, { encoding: "jsonParsed" })
    .send();
  return BigInt(res.value.data.parsed.info.unixTimestamp);
};

/** Poll the cluster clock until it passes `ts`. Bounded — never a blind sleep. */
async function waitForClock(ts: bigint, budgetMs = CLOCK_BUDGET_MS): Promise<bigint> {
  const started = Date.now();
  for (;;) {
    const now = await chainNow();
    if (now >= ts) return now;
    if (Date.now() - started > budgetMs) {
      throw new Error(`devnet clock did not reach ${ts} within ${budgetMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

console.log(`cluster   devnet`);
console.log(`program   ${programId}`);
console.log(`explorer  ${explorer(`address/${programId}`)}`);
console.log(`payer     ${admin.address}`);

const lp = await generateKeyPairSigner();
const shipper = await generateKeyPairSigner();
await send(
  [lp, shipper].map((who) =>
    getTransferSolInstruction({
      source: admin,
      destination: who.address,
      amount: lamports(20_000_000n),
    }),
  ),
);

const usdcMint = await generateKeyPairSigner();
const config = await configPda(programId, usdcMint.address, ATTESTER_ADDRESS);
const treasury = await treasuryPda(programId, config);
const h: Harness = { client, programId, admin, usdcMint: usdcMint.address, config, treasury };

// -------------------------------------------------------------------- stage 0

console.log(cyan("\nstage 0 — test USDC mint on devnet (self-minted, valueless — not real USDC)"));
await send([
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
    mintAuthority: admin.address,
    freezeAuthority: null,
  }),
]);
check(`mint ${usdcMint.address.slice(0, 8)}… created, 6 decimals`, true);

for (const [who, amount] of [
  [lp, 2_000_000n * USDC],
  [shipper, 200_000n * USDC],
] as const) {
  const plan = await getMintToATAInstructionPlanAsync({
    payer: admin,
    owner: who.address,
    mint: usdcMint.address,
    mintAuthority: admin,
    amount,
    decimals: DECIMALS,
  });
  await send(flattenInstructionPlan(plan));
}
check("test USDC minted to LP and shipper (demo money, holds no value)", true);

// -------------------------------------------------------------------- stage 1

console.log(cyan("\nstage 1 — initialize_pool"));
await send([initializePool(h, FEE_BPS, attester, admin.address, admin.address)]);
let pool = await readPool(h);
report("after initialize_pool", pool);
check(`fee_bps = ${pool.feeBps}`, pool.feeBps === FEE_BPS);
check("capital 0", pool.totalCapital === 0n);
check("oracle_authority is the attester", pool.oracleAuthority === ATTESTER_ADDRESS);

// -------------------------------------------------------------------- stage 2

console.log(cyan("\nstage 2 — deposit_capital"));
await send([await depositCapital(h, lp, DEPOSIT)]);
pool = await readPool(h);
report("after deposit_capital", pool);
check("capital equals deposit", pool.totalCapital === DEPOSIT);
check("shares minted 1:1", pool.totalShares === DEPOSIT);

// -------------------------------------------- helpers: quote + buy, and settle

/** `get_quote` then `buy_policy`, printing the terms the underwriter authored. */
async function quoteAndBuy(id: bigint, expected: bigint, payout: bigint, premium: bigint) {
  console.log(
    `  ${cyan("get_quote")}   quote ${id}: payout ${usdc(payout)}, premium ${usdc(premium)}, fee ${FEE_BPS / 100}% (${usdc((premium * BigInt(FEE_BPS)) / 10_000n)})`,
  );
  await send([
    await getQuote(h, admin, {
      quoteId: id,
      shipmentId: 27n,
      expectedDelivery: expected,
      gracePeriod: 0n,
      payoutAmount: payout,
      premiumAmount: premium,
      buyer: OPEN_BUYER,
      expiresAt: expected,
    }),
  ]);
  console.log(
    `  ${cyan("buy_policy")}  policy ${id}: ${usdc(payout)} locked, ${usdc(premium)} premium paid by the shipper`,
  );
  await send([await buyPolicy(h, shipper, { policyId: id, quoteId: id })]);
  console.log(`  ${dim(`deadline ${new Date(Number(expected) * 1000).toISOString()}`)}`);
}

/** Settle one policy against a signed arrival; the PDA must be gone afterwards. */
async function settle(id: bigint, arrival: bigint) {
  const { instructions } = await deliveryInstructions(h, {
    privateKey: ATTESTER_KEY,
    publicKey: ATTESTER_PUBKEY,
    shipmentId: 27n,
    actualDelivery: arrival,
    terminalCode: 4201n,
    nonce: id,
    crank: admin,
    insured: shipper.address,
  });
  await send(instructions);
  const closed = await client.rpc.getAccountInfo(await policyPda(programId, config, id)).send();
  check(`policy ${id} settled and its PDA closed`, closed.value === null);
}

// -------------------------------------------------------------------- stage 3

console.log(cyan("\nstage 3 — get_quote + buy_policy"));

console.log(yellow("\ncase a — the shipment is not late → no payout"));
const onTimeDue = (await chainNow()) + QUOTE_AHEAD;
check("quote is in the future", onTimeDue > (await chainNow()));
await quoteAndBuy(1n, onTimeDue, ONTIME_PAYOUT, ONTIME_PREMIUM);
const boughtOnTime = await readPool(h);
report("after buy_policy", boughtOnTime);
check(`payout risk locked ${usdc(ONTIME_PAYOUT)}`, boughtOnTime.totalLockedRisk === ONTIME_PAYOUT);
check(
  `fees taken at ${FEE_BPS}bps`,
  boughtOnTime.totalFees === (ONTIME_PREMIUM * BigInt(FEE_BPS)) / 10_000n,
);

// No time travel on devnet: wait on the real cluster clock for the deadline.
const onTimeReached = await waitForClock(onTimeDue);
check(`cluster clock reached the deadline (now ${onTimeReached})`, onTimeReached >= onTimeDue);
// Arrival inside the deadline (grace is 0) — it pays nothing, but frees the lock.
// The offset is seconds, not a minute: the whole quote-to-deadline window is 10s.
await settle(1n, onTimeDue - ARRIVAL_OFFSET);
pool = await readPool(h);
report("after settle_policy", pool);
check("lock released — no risk outstanding", pool.totalLockedRisk === 0n);
check("capital unchanged — no payout on an on-time arrival", pool.totalCapital === boughtOnTime.totalCapital);
check(
  `whole capital is free — ${usdc(pool.totalCapital)}`,
  pool.totalCapital - pool.totalLockedRisk === pool.totalCapital,
);

// -------------------------------------------------------------------- case b

console.log(yellow("\ncase b — the shipment is late → payout"));
const lateDue = (await chainNow()) + QUOTE_AHEAD;
await quoteAndBuy(2n, lateDue, LATE_PAYOUT, LATE_PREMIUM);
const boughtLate = await readPool(h);
report("after buy_policy", boughtLate);
check(`payout risk locked ${usdc(LATE_PAYOUT)}`, boughtLate.totalLockedRisk === LATE_PAYOUT);

const lateReached = await waitForClock(lateDue);
check(`cluster clock reached the deadline (now ${lateReached})`, lateReached >= lateDue);
// Five seconds past the deadline: the payout leaves the treasury.
await settle(2n, lateDue + ARRIVAL_OFFSET);
pool = await readPool(h);
report("after settle_policy", pool);
check("lock released — no risk outstanding", pool.totalLockedRisk === 0n);
check(`capital debited by the payout ${usdc(LATE_PAYOUT)}`, pool.totalCapital === boughtLate.totalCapital - LATE_PAYOUT);

// -------------------------------------------------------------------- stage 4

console.log(cyan("\nstage 4 — keeper posts a history-batch root"));
const root = new Uint8Array(32).fill(0xab);
await send([await postRoot(h, admin, 1n, root, 2n)]);
const registry = await client.rpc.getAccountInfo(await registryPda(programId, config, 1n)).send();
check("registry posted", registry.value !== null);
console.log(`  pool     ${explorer(`address/${config}`)}`);
console.log(`  treasury ${explorer(`address/${treasury}`)}`);

console.log(failures === 0 ? green("\n✓ all checks passed on devnet") : red(`\n✗ ${failures} check(s) FAILED`));
process.exit(failures === 0 ? 0 : 1);
