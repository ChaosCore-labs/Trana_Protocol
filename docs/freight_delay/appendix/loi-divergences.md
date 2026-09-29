# LOI vs Code

`LOI_DELIVERABLE_FREIGHT_DELAY.md` is the project's design document. It is a
deliverable, not a specification, and parts of it describe a protocol that was
never built. Use it for vocabulary, then verify against `src/`.

This page lists every material divergence, so a reader of the design document
does not form a wrong picture of the program.

## Instruction-level

| Design document (§7.3) | Reality |
|---|---|
| 7 instructions, including `request_withdrawal` | **6 instructions.** `request_withdrawal` does not exist |
| `request_withdrawal` starts a 7-day unbonding cooldown | No cooldown of any kind. `withdraw_capital` is immediate |
| `withdraw_capital` redeems "matured unbonded shares" | Redeems any shares the caller holds, capped by free capital |
| `report_delivery_milestone` writes a `DeliveryReport` | **Matches** |

## Account-level

| Design document (§7.1, §8) | Reality |
|---|---|
| `TreasuryVault` struct | No such struct. The treasury is an SPL `TokenAccount` with `PoolConfig` as authority |
| `LpPosition.unbonding_shares` | Field does not exist |
| `LpPosition.unbonding_timestamp` | Field does not exist |
| `Policy` keyed by `tracking_hash` | Modelled as a `u64 shipment_id`; the program has no hash type |
| `Policy.expected_delivery`, `Policy.grace_period` | **Match** |
| `DeliveryReport` seeds `[delivery, tracking_hash]` | Derives as `[delivery, shipment_id_le]` |
| `PoolConfig` seeds `[config, usdc_mint]` | **Matches** |
| `treasury` seeds `[treasury, pool_config]` | **Matches** the derivation; differs only in what the account is |
| `LpPosition` seeds `[lp_position, pool_config, lp]` | **Matches** |
| `Policy` seeds `[policy, pool_config, policy_id]` | **Matches** |

PDA derivations are largely faithful — the design document gets the seed shapes
right. Where it diverges, it invents fields on accounts that exist.

The string `unbonding` appears nowhere in `freight_delay/programs/freight_delay/src/`.

## Governance-level

The design document's actor list (§6) assigns the governance multisig two
capabilities:

| Claimed capability | Reality |
|---|---|
| `initialize_pool` | Exists, and is the only one of the two |
| "set supported corridors and fee bps" | **No setter instruction exists.** `fee_bps` and `oracle_authority` are immutable after init |

There is no instruction gated on `PoolConfig.admin` at all — the field is written
at initialisation and never read. A pool whose oracle key is compromised cannot
be repaired; it must be abandoned.

## Oracle and data pipeline

The design document describes production oracle architecture as Switchboard TEE
Functions cross-referencing Project44 carrier APIs and Spire Maritime AIS
satellites, with hardware attestation, and labels the devnet arrangement a
"permissionless crank".

In this repository:

- No Switchboard dependency, no TEE, no HTTP, no AIS, no attestation verification.
- `report_delivery_milestone` checks one thing:
  `reporter.key() == config.oracle_authority`.
- The `actual_delivery` value is trusted exactly as signed.

The distinction matters for risk assessment. The documented architecture bounds
oracle trust with hardware attestation and independent cross-checks; the
implemented program has no such bound.

## Claims that do hold

For balance, the design document's central claims are accurate where they matter
most:

| Claim | Verdict |
|---|---|
| "100% full collateralization enforced in Anchor (`total_locked_risk <= total_capital`)" (§2.2) | **Correct**, and enforced after every mutation, not only at entry |
| Permissionless settlement by a crank | **Correct** — `settle_policy` has no authority check |
| Parametric trigger on an attested value, no manual adjuster | **Correct** |
| USDC-denominated premiums and payouts | **Correct** |
| Program-owned vault the admin cannot drain | **Correct**, via PDA authority |

The solvency invariant — the design document's central safety claim — is the
part the code implements most faithfully.

## Claims with no implementation

Beyond governance and the oracle, the design document describes behaviour the
program does not have:

| Claim | Source | Reality |
|---|---|---|
| LP yield of "12–15% annualized" | §2.1, §3.2 | No pricing, yield, or APY logic exists on chain |
| Unbonding cooldown "to prevent bank runs during reported port strikes" | §7.3, Part 2 | No cooldown; withdrawal is immediate and unqueued |
| Premium yield accrues to LPs | §3.2 | Accrues to `total_capital` — correct, though the protocol fee is uncollectible |
| "Sub-second settlement" | §2.1 | Settlement is a transaction; latency is a cluster property, not a program one |

## Practical guidance

**Trust the code, not the document.** Where they disagree, `src/` is the
specification.

**Two divergences change how the protocol behaves, not just how it is described:**

1. **No unbonding cooldown.** The design document treats the cooldown as a
   risk-management feature protecting LPs from withdrawal races during reported
   port strikes. The implemented program has no such protection; LPs can exit
   immediately, bounded only by free capital.

2. **No governance setters.** The design document treats oracle authority and
   fee rate as governable parameters. In the program they are permanent
   initialisation choices, so a compromised oracle key means an unrepairable pool.

Neither is a bug in the code — both are honest omissions. They are listed so
that nobody plans around a feature that does not exist.

## Related

- [Scope & Status](/freight_delay/introduction/scope) — what the repository contains
- [Invariants](/freight_delay/protocol/invariants) — the claims that do hold, argued
- [Architecture](/freight_delay/protocol/architecture) — the account graph the code actually has
