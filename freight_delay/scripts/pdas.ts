#!/usr/bin/env bun
/**
 * Print the four addresses an instruction on Explorer asks for.
 *
 *   bun run pdas                        # the demo mint and the DEVNET_KEYPAIR wallet
 *   bun run pdas <mint> [attester]      # any other pool
 *
 * Explorer derives `config` and `treasury` on its own, but only once the accounts
 * their seeds reference are filled in — the mint and the attester, in that order.
 * This prints the whole set so nothing has to be derived by hand.
 */

import { address, createClient, type Address } from "@solana/kit";
import { payerFromFile } from "@solana/kit-plugin-signer";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

import { FREIGHT_DELAY_PROGRAM_ADDRESS, findConfigPda, findTreasuryPda } from "../client/generated/index.ts";
import { DEMO_MINT, DEVNET_KEYPAIR, explorer } from "./demo.ts";

const [mintArg, attesterArg] = process.argv.slice(2);
const mint: Address = mintArg ? address(mintArg) : DEMO_MINT;
const payer = (await createClient().use(payerFromFile(DEVNET_KEYPAIR))).payer;
const attester: Address = attesterArg ? address(attesterArg) : payer.address;

const [config, configBump] = await findConfigPda(
  { usdcMint: mint, oracleAuthority: attester },
  { programAddress: FREIGHT_DELAY_PROGRAM_ADDRESS },
);
const [treasury, treasuryBump] = await findTreasuryPda(
  { config },
  { programAddress: FREIGHT_DELAY_PROGRAM_ADDRESS },
);

const rows: [string, string][] = [
  ["program", FREIGHT_DELAY_PROGRAM_ADDRESS],
  ["usdc_mint", mint],
  ["oracle_authority", attester],
  ["config", `${config}  (bump ${configBump})`],
  ["treasury", `${treasury}  (bump ${treasuryBump})`],
];

const width = Math.max(...rows.map(([k]) => k.length));
for (const [k, v] of rows) console.log(`${k.padEnd(width)}  ${v}`);

console.log(`
initialize_pool on Explorer, in the order the form asks:
  admin             ${payer.address}   (signer: your wallet)
  usdc_mint         ${mint}
  oracle_authority  ${attester}   (signer: signs for the pool's oracle key)
  config            ${config}
  treasury          ${treasury}
  token_program     ${TOKEN_PROGRAM_ADDRESS}
  system_program    ${SYSTEM_PROGRAM_ADDRESS}
  args              fee_bps 200, keeper + underwriter = your wallet

keeper, underwriter and oracle_authority are stored at initialize_pool, so set all
three to the wallet above: then this one key can also call get_quote, post_root, and
sign the oracle's attestations (bun run attest --keypair ~/.config/solana/id.json).

${explorer(`address/${config}`)}
`);
