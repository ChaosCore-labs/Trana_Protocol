#!/usr/bin/env bun
/**
 * Create the one devnet demo USDC mint, so hand-driven interaction stops moving.
 *
 *   bun run demo-mint            # create it, or reuse what already exists
 *   bun run demo-mint --top-up   # mint the starter balance again
 *
 * The mint authority is the paying wallet (`DEVNET_KEYPAIR`), not the mint's own
 * keypair, so minting more demo USDC later needs nothing but the wallet.
 */

import {
  createClient,
  createKeyPairSignerFromPrivateKeyBytes,
  devnet,
  flattenInstructionPlan,
  getAddressEncoder,
  type KeyPairSigner,
} from "@solana/kit";
import { solanaDevnetRpc } from "@solana/kit-plugin-rpc";
import { payerFromFile } from "@solana/kit-plugin-signer";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getInitializeMintInstruction,
  getMintToATAInstructionPlanAsync,
} from "@solana-program/token";

import {
  DEMO_DECIMALS,
  DEMO_MINT_KEYPAIR,
  DEMO_START_BALANCE,
  DEVNET_KEYPAIR,
  MINT_SPACE,
  explorer,
} from "./demo.ts";

const client = await createClient()
  .use(payerFromFile(DEVNET_KEYPAIR))
  .use(
    solanaDevnetRpc({
      rpcUrl: devnet(process.env.DEVNET_RPC ?? "https://api.devnet.solana.com"),
      maxConcurrency: 1,
    }),
  );
const admin = client.payer;

/** A 429 is refused before submission, so a retry cannot double-apply. */
async function send(ixs: Parameters<typeof client.sendTransaction>[0]) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.sendTransaction(ixs);
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      if (!/429|Too Many Requests|rate limit/i.test(message) || attempt >= 6) throw e;
      const wait = 2_000 * attempt;
      console.log(`  … devnet rpc busy, retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

const file = Bun.file(DEMO_MINT_KEYPAIR);
const saved = await file.exists();
const seed = saved
  ? Uint8Array.from((JSON.parse(await file.text()) as number[]).slice(0, 32))
  : crypto.getRandomValues(new Uint8Array(32));
const mint: KeyPairSigner = await createKeyPairSignerFromPrivateKeyBytes(seed);

if (!saved) {
  const pubkey = new Uint8Array(getAddressEncoder().encode(mint.address));
  await Bun.write(DEMO_MINT_KEYPAIR, JSON.stringify([...seed, ...pubkey]));
  console.log(`keypair  wrote ${DEMO_MINT_KEYPAIR} (git-ignored)`);
}

console.log(`payer    ${admin.address}`);
console.log(`mint     ${mint.address}`);

const onChain = await client.rpc.getAccountInfo(mint.address, { encoding: "base64" }).send();
if (onChain.value) {
  console.log("state    already on devnet — reusing it");
} else {
  await send([
    getCreateAccountInstruction({
      payer: admin,
      newAccount: mint,
      lamports: 1_500_000n,
      space: MINT_SPACE,
      programAddress: TOKEN_PROGRAM_ADDRESS,
    }),
    getInitializeMintInstruction({
      mint: mint.address,
      decimals: DEMO_DECIMALS,
      mintAuthority: admin.address,
      freezeAuthority: null,
    }),
  ]);
  console.log(`state    created, ${DEMO_DECIMALS} decimals, authority ${admin.address}`);
}

const [ata] = await findAssociatedTokenPda({
  owner: admin.address,
  tokenProgram: TOKEN_PROGRAM_ADDRESS,
  mint: mint.address,
});
const funded = (await client.rpc.getAccountInfo(ata, { encoding: "base64" }).send()).value !== null;

if (!funded || process.argv.includes("--top-up")) {
  const plan = await getMintToATAInstructionPlanAsync({
    payer: admin,
    owner: admin.address,
    mint: mint.address,
    mintAuthority: admin,
    amount: DEMO_START_BALANCE,
    decimals: DEMO_DECIMALS,
  });
  await send(flattenInstructionPlan(plan));
  console.log(`balance  minted ${DEMO_START_BALANCE / 10n ** BigInt(DEMO_DECIMALS)} demo USDC to ${ata}`);
} else {
  console.log(`balance  already funded at ${ata} (pass --top-up to mint more)`);
}

console.log(`
explorer  ${explorer(`address/${mint.address}`)}

Record that address as DEMO_MINT in scripts/demo.ts, then run: bun run pdas
`);
