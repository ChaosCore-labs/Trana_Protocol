# Accounts & State

Five account types, all defined in `state.rs` with `#[derive(InitSpace)]`. Every
one is allocated as `8 + X::INIT_SPACE`, where the leading 8 bytes are Anchor's
discriminator.

There is deliberately no account for delivery attestations. A settlement
attestation arrives as instruction data and is verified by signature, not
stored — see [Settlement](/freight_delay/workflows/lifecycle).

::: warning Layout is positional
Field order is the account layout. Inserting or reordering a field silently
changes how live accounts decode — `InitSpace` recomputes the size without
erroring, so nothing fails at build time. Treat the field order below as frozen.
:::

## `PoolConfig` — the accounting hub

Seeds `[b"config", usdc_mint, oracle_authority]`. One pool per *(mint, attester)*
pair: the attester's key sits inside the address, so the pool for a known attester
cannot be created — or squatted — by anyone else.

| Field | Type | Bytes | Meaning |
|---|---|---|---|
| `admin` | `Pubkey` | 32 | Recorded at init; **never read by any handler** |
| `oracle_authority` | `Pubkey` | 32 | The attester's raw 32-byte ed25519 public key; the only key whose signature settles a policy |
| `keeper` | `Pubkey` | 32 | The only key that may `post_root`; immutable after init |
| `underwriter` | `Pubkey` | 32 | The only key that may `get_quote`, so it authors every price; immutable after init, and deliberately not the same key as `oracle_authority` |
| `usdc_mint` | `Pubkey` | 32 | The pool's mint; also a seed component |
| `treasury` | `Pubkey` | 32 | The program-owned token account |
| `total_capital` | `u64` | 8 | Deposits plus net premiums minus realised payouts |
| `total_locked_risk` | `u64` | 8 | Sum of `payout_amount` over unsettled policies |
| `total_shares` | `u64` | 8 | Sum of all LP shares |
| `total_fees` | `u64` | 8 | Protocol fees accrued; **never decremented** |
| `last_policy_id` | `u64` | 8 | Highest id issued; ids strictly increase, within `MAX_POLICY_ID_GAP` of the previous one, and never repeat |
| `fee_bps` | `u16` | 2 | Premium fee in basis points, immutable after init |
| `bump` | `u8` | 1 | PDA bump |
| | | **235** | `space = 8 + 235 = 243` |

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

`assert_solvent()` is called at the end of every handler that moves capital or
risk — `deposit_capital`, `buy_policy`, `settle_policy`, `withdraw_capital` —
making full collateralisation a per-instruction re-check rather than a single
entry gate. `initialize_pool` is the exception: it creates the pool at zero risk.
`get_quote` is the other: it creates terms and moves nothing, so it has no check
to make.

## `Registry` — a posted history-batch root

Seeds `[b"registry", config, epoch_le]`. One PDA per epoch, written once by the
keeper (`post_root`), so each batch's root is as permanent as any other account.

| Field | Type | Bytes | Meaning |
|---|---|---|---|
| `epoch` | `u64` | 8 | Batch number, part of the seeds |
| `root` | `[u8; 32]` | 32 | Merkle root over the batch's `PolicyClosed` leaves |
| `count` | `u64` | 8 | Leaves the root covers |
| | | **48** | `space = 8 + 48 = 56` |

The program cannot verify a Merkle root on chain, so it does not try: it
authenticates the poster against `PoolConfig.keeper` and stores the root. Anyone
holding the batch data can verify a policy's inclusion, so a forged record is
detectable; a withheld batch is not. The chain's `PolicyClosed` events remain the
availability backstop, so the off-chain database is rebuildable without the keeper.

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

Seeds `[b"policy", config, policy_id_le]`, with `policy_id` little-endian. The
buyer picks the id, but it must be strictly greater than the pool's
`last_policy_id` and no more than `MAX_POLICY_ID_GAP` ahead of it, and it is spent
from then on: the attester's `nonce` is the policy id, so a reused id would let a
stale attestation settle a policy it was not signed for, and a runaway id would
spend the remaining id space out from under every later policy (CHA-18).

The account is **closed at settlement** (CHA-18): `settle_policy` emits
`PolicyClosed` and sends the account's rent to the shipper. The chain events, not
this account, are the permanent record — nothing else stores the policy's terms
once the PDA is gone.

| Field | Type | Bytes | Meaning |
|---|---|---|---|
| `insured` | `Pubkey` | 32 | Payout recipient; also the account constraint at settlement |
| `policy_id` | `u64` | 8 | Caller-chosen identifier, at most `MAX_POLICY_ID_GAP` past the counter |
| `shipment_id` | `u64` | 8 | Bill of lading matched against a settlement attestation |
| `expected_delivery` | `i64` | 8 | The SLA arrival timestamp the shipment was quoted |
| `grace_period` | `i64` | 8 | Slack after `expected_delivery` before a delay triggers |
| `payout_amount` | `u64` | 8 | USDC paid on trigger |
| `premium_amount` | `u64` | 8 | USDC paid up front |
| `is_settled` | `bool` | 1 | Settlement is once-only |
| `is_paid` | `bool` | 1 | Set only when a payout actually transferred |
| `bump` | `u8` | 1 | PDA bump |
| | | **83** | `space = 8 + 83 = 91` |

`is_settled` and `is_paid` are not redundant while the account is live. A policy
that settles without a trigger ends with `is_settled = true, is_paid = false` —
the risk was released without a transfer. Neither flag outlives settlement: the
PDA is closed (CHA-18), so both are only ever read during the settling
transaction.

The effective trigger boundary is `expected_delivery + grace_period`, computed at
settlement time rather than stored. `get_quote` requires that sum to land inside
`(now, now + MAX_SLA_SECONDS]`: settlement recomputes it, so a pair outside the
horizon — or one whose sum overflows `i64` — would leave the policy permanently
unsettleable and lock its collateral for good. Neither term is validated for
realism inside the horizon: any future date and any non-negative `grace_period`
are accepted, however unlikely the voyage is to match them.

## `Quote` — one seller-authored offer

Seeds `[b"quote", config, quote_id_le]`. Written only by `PoolConfig.underwriter`
and **closed by `buy_policy`**, so one quote backs exactly one policy. Every term
of the sale comes from here — the buyer passes no term at all, which is what stops
a buyer naming its own price.

| Field | Type | Bytes | Meaning |
|---|---|---|---|
| `underwriter` | `Pubkey` | 32 | Who authored the terms; kept for provenance, since the address already implies it |
| `buyer` | `Pubkey` | 32 | `Pubkey::default()` means open to any buyer |
| `quote_id` | `u64` | 8 | Caller-chosen, and reusable once the account is closed |
| `shipment_id` | `u64` | 8 | Copied into the policy |
| `expected_delivery` | `i64` | 8 | Copied into the policy |
| `grace_period` | `i64` | 8 | Copied into the policy |
| `payout_amount` | `u64` | 8 | Copied into the policy; the risk the pool takes on |
| `premium_amount` | `u64` | 8 | Copied into the policy; the price the buyer pays |
| `expires_at` | `i64` | 8 | Last moment the terms may be accepted, never later than `expected_delivery` |
| `bump` | `u8` | 1 | PDA bump |
| | | **113** | `space = 8 + 113 = 121` |

`expires_at` is bounded above by `expected_delivery` at authoring time, so terms
cannot be accepted once the ship is due — without that a buyer who already knew
the vessel was late could accept them and collect. The account is closed rather
than flagged, so an accepted quote cannot be presented twice; a quote nobody
accepts simply stays, and there is no instruction that reclaims its rent.

## Where the USDC actually is

The treasury is not a program data account. It is an SPL `TokenAccount` created
at `initialize_pool` with seeds `[b"treasury", config]` and
`token::authority = config`. Its owner is the SPL Token program; the `PoolConfig`
PDA is merely its authority.

That indirection is the security boundary: moving funds requires the program to
produce `[b"config", usdc_mint, oracle_authority, bump]` as signer seeds inside a
CPI, which no external caller can do.

## Related

- [PDA Seeds & Constants](/freight_delay/reference/seeds) — literals and derivation
- [Invariants](/freight_delay/protocol/invariants) — what the accounting guarantees
