# Local Walkthrough

The local MVP: one script that drives the whole protocol end to end and prints
every state transition. There is no UI.

```bash
cd freight_delay
anchor build            # the script deploys target/deploy/freight_delay.so
bun run lifecycle
```

`anchor build` first is not optional. The script deploys the compiled `.so`, so
a stale artifact silently walks through old code.

## What it runs

`freight_delay/scripts/lifecycle.ts` boots an embedded [Surfnet](https://solana.com/docs/tools/surfpool)
in-process, deploys the program, and then:

| Stage | Instruction | Asserts |
|---|---|---|
| 0 | — | a test USDC mint exists and the LP and shipper hold balances |
| 1 | `initialize_pool` | `fee_bps` recorded, capital starts at zero |
| 2 | `deposit_capital` | capital equals the deposit, shares mint 1:1 |
| 3 | `buy_policy` | payout locked, premium credited net of fee |
| 4a | `settle_policy` | a **late** arrival pays, capital debited by the payout |
| 4b | `settle_policy` | an **on-time** arrival pays nothing but releases the lock |
| 5 | `settle_policy` | the last open policy releases its lock; free capital equals total |

Each stage prints `total_capital`, `total_locked_risk`, `free_capital` and
`total_fees`, so the accounting is readable without a debugger. The script exits
non-zero if any assertion fails.

## The attester is the real one

Stage 4 signs the arrival with `attester/src/signing.ts` and encodes it with
`attester/src/payload.ts` — the same code an operator would run. The program
accepts it because the pool was initialised with that key's raw ed25519 public
key as `oracle_authority`.

Nothing about the signature is mocked. Swapping in a real data source changes
where the timestamp comes from, not what is signed.

## How settlement is reached

`settle_policy` refuses a policy before `expected_delivery + grace_period`, so
the script advances the validator clock rather than waiting:

```ts
client.surfnet.timeTravelToTimestamp((Number(deadline) + DAY) * 1000);
```

Time travel is forward-only, so the script orders its scenarios accordingly and
re-quotes each policy from the current chain time. It reads the validator's own
`Clock` sysvar rather than the host clock, since Surfnet does not start at wall
time.

## Supporting files

| File | Role |
|---|---|
| `scripts/lifecycle.ts` | the walkthrough |
| `client/program.ts` | harness over the generated client (builders, PDAs, account codecs) |
| `client/generated/` | Codama client generated from `target/idl/freight_delay.json` |
| `scripts/codegen.ts` | regenerates `client/generated` |

`client/program.ts` builds its instructions with the clients Codama generates
from the program IDL, so discriminators, account order and Borsh layouts come
from the program rather than being written out by hand. After changing the
program, run `anchor build && bun run codegen`. The ed25519 precompile
instruction in that file is the one thing the IDL cannot describe.

## Related

- [Pool Lifecycle](/freight_delay/workflows/lifecycle) — the same sequence as a diagram
- [Instructions](/freight_delay/protocol/instructions) — the guards each stage exercises
- [Invariants](/freight_delay/protocol/invariants) — what the accounting assertion proves
