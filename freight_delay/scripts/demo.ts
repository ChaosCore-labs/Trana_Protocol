/**
 * The fixed inputs of the devnet demo pool.
 *
 * `devnet-e2e` mints a throwaway token per run, so every run's pool lands at a new
 * address: fine for a clean-room proof, useless for clicking instructions by hand.
 * `DEMO_MINT` is the one token that does not move.
 */

import { address, type Address } from "@solana/kit";

/** Created by `bun run demo-mint`, which prints the address to record here. */
export const DEMO_MINT: Address = address("HfYYAGXcDEVup6DK9ru2pC1cLHtRp1Fxmtgfjxqv8v95");

/** The program rejects any mint that is not 6 decimals, so the demo token matches. */
export const DEMO_DECIMALS = 6;

export const MINT_SPACE = 82n;

export const DEMO_START_BALANCE = 5_000_000n * 10n ** BigInt(DEMO_DECIMALS);

/** Written by `bun run demo-mint`, and needed only to create the mint: its authority is the wallet. */
export const DEMO_MINT_KEYPAIR = new URL("../.demo/demo-mint.json", import.meta.url).pathname;

export const DEVNET_KEYPAIR = process.env.DEVNET_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`;

export const explorer = (what: string) => `https://explorer.solana.com/${what}?cluster=devnet`;
