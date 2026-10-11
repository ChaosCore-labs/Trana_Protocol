# Scope & Status

This documentation describes what is in the repository, verified against the
source. It is not a roadmap.

## What this repository contains

```text
Trana_Protocol/
├── freight_delay/
│   ├── programs/freight_delay/
│   │   ├── src/              # the Anchor program
│   │   └── tests/            # LiteSVM integration tests (15 tests)
│   ├── runbooks/             # surfpool / txtx deploy scaffolding
│   └── Anchor.toml
├── mise.toml                 # toolchain pins
├── LOI_DELIVERABLE_FREIGHT_DELAY.md  # design intent (partly stale — see appendix)
└── docs/                     # this site
```

The program is the whole deliverable. There is no frontend, no client SDK, no
indexer, no API service, and no on-chain oracle integration.

## What exists on chain

| Surface | Count | Detail |
|---|---|---|
| Instructions | 5 | `initialize_pool`, `deposit_capital`, `buy_policy`, `settle_policy`, `withdraw_capital` |
| Account types | 3 | `PoolConfig`, `LpPosition`, `Policy` |
| Error variants | 12 | One flat `FreightDelayError` enum |
| Events | 6 | One per instruction, plus `DeliveryAttested` |
| Outbound CPIs | 1 | `transfer_from_treasury`, SPL Token `transfer` |

## What is explicitly *not* implemented

Each of these appears in the design document or in a plausible reading of the
protocol, and none of them exists in `src/`:

- **`request_withdrawal` and the 7-day unbonding cooldown.** Withdrawal is
  immediate; there is no `unbonding_shares` or `unbonding_timestamp` field, and
  the string `unbonding` appears nowhere in the program.
- **A `TreasuryVault` account struct.** The treasury is an SPL `TokenAccount`
  owned by the token program with the `PoolConfig` PDA as authority.
- **Any governance or admin setter.** `fee_bps` and `oracle_authority` are fixed
  at initialisation and cannot be changed. `PoolConfig.admin` is never read.
- **A Project44 / Spire AIS / Switchboard-TEE oracle integration.** No oracle
  program, no TEE, no HTTP. The program verifies an ed25519 signature from the
  key configured at init (`oracle_authority`), but how that attester obtains the
  arrival is entirely off chain and out of protocol scope.
- **A fee withdrawal path.** `total_fees` accrues and can never be paid out.
- **A refund or timeout for unsettleable policies.** If a shipment is never
  attested, the locked risk is permanent.
- **A crank incentive.** Settlement is permissionless and unpaid.

The [LOI vs Code](/freight_delay/appendix/loi-divergences) appendix lists these
divergences against the specific sections of the design document that claim
them.

## Maturity

The program has never been deployed to a public cluster in this repository's
history. `Anchor.toml` configures `localnet` only, with the program id pinned as
`4BtUosFfNUySEGAGspfjvStCzLzqSRdfoc4Z3Z1uqGJs`.

Test coverage is 15 LiteSVM integration tests covering the happy path of every
instruction plus several rejection cases. The suite passes. It is not a security
audit — most notably, no test exercises a second deposit, no test asserts a
specific error code, and no test covers arithmetic boundaries.

Treat the program as pre-audit. The invariant that matters (full
collateralisation) does hold under the arithmetic as written, and that is argued
in [Invariants](/freight_delay/protocol/invariants) rather than asserted.
