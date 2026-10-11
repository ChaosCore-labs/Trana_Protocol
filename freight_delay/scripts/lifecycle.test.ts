/**
 * Guards the hand-written encoding in src/program.ts (CHA-31).
 *
 * The script encodes Anchor instruction data and reads account fields by
 * offset. Both are checked here against the deployed artifacts, so a program
 * change fails a test rather than producing a script that silently misreads.
 *
 *   cd freight_delay && anchor build && bun test
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const IDL = JSON.parse(readFileSync(new URL("../target/idl/freight_delay.json", import.meta.url), "utf8"));
const SRC = readFileSync(new URL("../programs/freight_delay/src/state.rs", import.meta.url), "utf8");

const discOf = (name: string): number[] =>
  [...IDL.instructions.find((i: { name: string }) => i.name === name).discriminator];

describe("instruction discriminators", () => {
  // Mirrors DISC in src/program.ts.
  const expected: Record<string, number[]> = {
    initializePool: [95, 180, 10, 172, 84, 174, 232, 40],
    depositCapital: [157, 98, 40, 41, 205, 210, 121, 253],
    buyPolicy: [0, 59, 201, 101, 183, 3, 41, 24],
    settlePolicy: [180, 234, 21, 174, 50, 214, 91, 113],
    withdrawCapital: [82, 32, 82, 118, 160, 116, 65, 104],
  };

  const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

  for (const [camel, disc] of Object.entries(expected)) {
    test(`${snake(camel)}`, () => {
      expect(discOf(snake(camel))).toEqual(disc);
    });
  }

  test("no instruction is missing an entry", () => {
    expect(IDL.instructions.map((i: { name: string }) => i.name).sort()).toEqual(
      Object.keys(expected).map(snake).sort(),
    );
  });
});

describe("account data offsets", () => {
  // Mirrors OFF in src/program.ts, derived from the field order in state.rs.

  test("PoolConfig field order is what the offsets assume", () => {
    const body = SRC.slice(SRC.indexOf("pub struct PoolConfig"), SRC.indexOf("pub struct LpPosition"));
    const fields = [...body.matchAll(/pub (\w+): ([A-Za-z0-9<>]+)/g)].map((m) => `${m[2]} ${m[1]}`);
    expect(fields).toEqual([
      "Pubkey admin",
      "Pubkey oracle_authority",
      "Pubkey usdc_mint",
      "Pubkey treasury",
      "u64 total_capital",
      "u64 total_locked_risk",
      "u64 total_shares",
      "u64 total_fees",
      "u16 fee_bps",
      "u8 bump",
    ]);
  });

  test("Policy field order is what the offsets assume", () => {
    const body = SRC.slice(SRC.indexOf("pub struct Policy"), SRC.indexOf("pub struct Policy") + 700);
    const fields = [...body.matchAll(/pub (\w+): ([A-Za-z0-9<>]+)/g)].map((m) => `${m[2]} ${m[1]}`);
    expect(fields).toEqual([
      "Pubkey insured",
      "u64 policy_id",
      "u64 shipment_id",
      "i64 expected_delivery",
      "i64 grace_period",
      "u64 payout_amount",
      "u64 premium_amount",
      "bool is_settled",
      "bool is_paid",
      "u8 bump",
    ]);
  });

  test("is_settled/is_paid sit where program.ts reads them", () => {
    const size = (t: string): number =>
      t === "Pubkey" ? 32 : t === "bool" ? 1 : Number(t.replace(/[ui](\d+)/, "$1")) / 8;
    const body = SRC.slice(SRC.indexOf("pub struct Policy"), SRC.indexOf("pub struct Policy") + 700);
    const fields = [...body.matchAll(/pub (\w+): ([A-Za-z0-9<>]+)/g)].map((m) => ({
      type: m[2]!,
      name: m[1]!,
    }));
    let off = 8; // discriminator
    const at: Record<string, number> = {};
    for (const f of fields) {
      at[f.name] = off;
      off += size(f.type);
    }
    expect(at["is_settled"]).toBe(8 + 32 + 8 * 6);
    expect(at["is_paid"]).toBe(8 + 32 + 8 * 6 + 1);
  });
});