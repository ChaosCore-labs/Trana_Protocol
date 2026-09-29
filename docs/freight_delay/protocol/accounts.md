# Accounts & State

Four account types, all defined in `state.rs` with `#[derive(InitSpace)]`. Every
one is allocated as `8 + X::INIT_SPACE`, where the leading 8 bytes are Anchor's
discriminator.

::: warning Layout is positional
Field order is the account layout. Inserting or reordering a field silently
changes how live accounts decode — `InitSpace` recomputes the size without
erroring, so nothing fails at build time. Treat the field order below as frozen.
:::

## `PoolConfig` — the accounting hub

Seeds `[b"config", usdc_mint]`. One pool per USDC mint.

| Field | Type | Bytes | Meaning |
|---|---|---|---|
| `admin` | `Pubkey` | 32 | Recorded at init; **never read by any handler** |
| `oracle_authority` | `Pubkey` | 32 | Sole signer allowed to write `DeliveryReport` |
| `usdc_mint` | `Pubkey` | 32 | The pool's mint; also a seed component |
| `treasury` | `Pubkey` | 32 | The program-owned token account |
| `total_capital` | `u64` | 8 | Deposits plus net premiums minus realised payouts |
| `total_locked_risk` | `u64` | 8 | Sum of `payout_amount` over unsettled policies |
| `total_shares` | `u64` | 8 | Sum of all LP shares |
| `total_fees` | `u64` | 8 | Protocol fees accrued; **never decremented** |
| `fee_bps` | `u16` | 2 | Premium fee in basis points, immutable after init |
| `bump` | `u8` | 1 | PDA bump |
| | | **163** | `space = 8 + 163 = 171` |

Two methods live on this struct:

```rust
/// Capital not reserved against an outstanding policy payout.
pub fn free_capital(&self) -> u64 {
    self.total_capital.saturating_sub(self.total_locked_risk)
}

/// Full-collateralisation invariant: every payout must be backed by capital.
pub fn assert_solvent(&self) -> Result<()> {
    require!(
        self.total_locked_risk <= self.total_capital,
        FreightDelayError::Insolvent
    );
    Ok(())
}
```

`free_capital` uses `saturating_sub`, so it returns zero rather than underflowing
if the invariant were ever violated — the guard fails closed.

`assert_solvent()` is called at the end of all four state-mutating handlers
(`deposit_capital`, `buy_policy`, `settle_policy`, `withdraw_capital`), making
full collateralisation a per-instruction re-check rather than a single entry
gate.

## `LpPosition` — a share balance

Seeds `[b"lp_position", config, lp]`. The seed set means one LP has one position
per pool, and cannot address another LP's position.

| Field | Type | Bytes | Meaning |
|---|---|---|---|
| `lp` | `Pubkey` | 32 | Position owner; doubles as a first-deposit sentinel |
| `shares` | `u64` | 8 | Redeemable shares |
| `bump` | `u8` | 1 | PDA bump |
| | | **41** | `space = 8 + 41 = 49` |

This account is created with `init_if_needed`, because a first-time depositor
has no position yet. Anchor zero-fills a fresh account, so `deposit_capital`
distinguishes first from repeat deposit by testing
`lp_position.lp == Pubkey::default()` and only then writing `lp` and `bump`. The
sentinel is safe because the `lp` field is a signer in every path: the default
pubkey cannot sign.

## `Policy` — one hedge's terms

Seeds `[b"policy", config, policy_id_le]`. Note the little-endian encoding of
`policy_id`; the ID is chosen by the buyer, so any caller can mint any
unclaimed ID.

| Field | Type | Bytes | Meaning |
|---|---|---|---|
| `insured` | `Pubkey` | 32 | Payout recipient; also the account constraint at settlement |
| `policy_id` | `u64` | 8 | Caller-chosen identifier |
| `shipment_id` | `u64` | 8 | Bill of lading matched against a `DeliveryReport` |
| `expected_delivery` | `i64` | 8 | The SLA arrival timestamp the shipment was quoted |
| `grace_period` | `i64` | 8 | Slack after `expected_delivery` before a delay triggers |
| `payout_amount` | `u64` | 8 | USDC paid on trigger |
| `premium_amount` | `u64` | 8 | USDC paid up front |
| `is_settled` | `bool` | 1 | Settlement is once-only |
| `is_paid` | `bool` | 1 | Set only when a payout actually transferred |
| `bump` | `u8` | 1 | PDA bump |
| | | **83** | `space = 8 + 83 = 91` |

`is_settled` and `is_paid` are not redundant. A policy that settles without a
trigger ends with `is_settled = true, is_paid = false` — the risk was released
without a transfer. `is_paid` is write-once-true and never reset.

The effective trigger boundary is `expected_delivery + grace_period`, computed at
settlement time rather than stored. Neither term is validated for realism: any
future `expected_delivery` and any non-negative `grace_period` is accepted.

## `DeliveryReport` — an attested arrival

Seeds `[b"delivery", shipment_id_le]` — **not namespaced by config**.

| Field | Type | Bytes | Meaning |
|---|---|---|---|
| `shipment_id` | `u64` | 8 | Bill of lading the arrival belongs to |
| `actual_delivery` | `i64` | 8 | The attested arrival timestamp |
| `terminal_code` | `u64` | 8 | Gate-in terminal identifier; **never read by any handler** |
| `timestamp` | `i64` | 8 | Attestation time; **never read by any handler** |
| `reporter` | `Pubkey` | 32 | The authority that signed |
| `bump` | `u8` | 1 | PDA bump |
| | | **65** | `space = 8 + 65 = 73` |

Two properties of this account drive much of the protocol's behaviour:

**A report is global, not per-pool.** Because the seeds omit `config`, a
`shipment_id` arrival is a single fact any pool can read. Reports are therefore
shared infrastructure rather than pool-local state.

**A report is write-once.** `report_delivery_milestone` uses `init`, so
re-attesting the same shipment fails at the runtime level. Because the arrival is
trusted exactly as signed and neither `timestamp` nor `terminal_code` is ever
read back, an observation has no freshness or provenance guarantee on chain — a
value attested months before a policy was purchased settles that policy just as
validly as one attested yesterday.

## Where the USDC actually is

The treasury is not a program data account. It is an SPL `TokenAccount` created
at `initialize_pool` with seeds `[b"treasury", config]` and
`token::authority = config`. Its owner is the SPL Token program; the `PoolConfig`
PDA is merely its authority.

That indirection is the security boundary: moving funds requires the program to
produce `[b"config", usdc_mint, bump]` as signer seeds inside a CPI, which no
external caller can do.

## Related

- [PDA Seeds & Constants](/freight_delay/reference/seeds) — literals and derivation
- [Invariants](/freight_delay/protocol/invariants) — what the accounting guarantees
