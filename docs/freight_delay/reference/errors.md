# Error Codes

One flat enum, fourteen variants, every one carrying a `#[msg]`. There are no
nested error types and no `anyhow` anywhere in the program.

```rust
#[error_code]
pub enum FreightDelayError {
    Unauthorized,
    InvalidFee,
    InvalidAmount,
    InvalidDeadline,
    Insolvent,
    InsufficientFreeCapital,
    PolicyNotMature,
    PolicyAlreadySettled,
    DeliveryMismatch,
    InsufficientShares,
    MathOverflow,
    AttestationRejected,
    InvalidPolicyId,
    InvalidMint,
}
```

## Variants

Anchor numbers custom errors from 6000, in declaration order.

| Code | Variant | Message | Raised by |
|---|---|---|---|
| 6000 | `Unauthorized` | Only the configured authority may perform this action. | `withdraw_capital` `lp_position` constraint |
| 6001 | `InvalidFee` | Fee must be below 10,000 basis points. | `initialize_pool` |
| 6002 | `InvalidAmount` | Amount must be greater than zero. | `deposit_capital` (twice), `buy_policy` (twice), `withdraw_capital` (twice) |
| 6003 | `InvalidDeadline` | Expected delivery plus grace period must lie in the future and within the maximum SLA horizon. | `buy_policy` |
| 6004 | `Insolvent` | Pool is insolvent: locked risk would exceed total capital. | `buy_policy` free-capital gate; `assert_solvent()` |
| 6005 | `InsufficientFreeCapital` | Pool does not have enough unencumbered capital for this withdrawal, or the withdrawal would leave none while shares remain. | `settle_policy` (triggered), `withdraw_capital` |
| 6006 | `PolicyNotMature` | Policy has not reached its delivery deadline plus grace period. | `settle_policy` |
| 6007 | `PolicyAlreadySettled` | Policy has already been settled. | `settle_policy` |
| 6008 | `DeliveryMismatch` | Delivery report does not match the policy shipment. | `settle_policy` — attestation shipment differs from the policy's |
| 6009 | `InsufficientShares` | Not enough shares to redeem. | `withdraw_capital` |
| 6010 | `MathOverflow` | Arithmetic overflow. | Every `checked_*` money path |
| 6011 | `AttestationRejected` | Delivery attestation signature is missing or invalid. | `settle_policy` — signature check and nonce check |
| 6012 | `InvalidPolicyId` | Policy id must be greater than the last one issued for this pool, and within the id window. | `buy_policy` |
| 6013 | `InvalidMint` | Mint must use 6 decimals. | `initialize_pool` `usdc_mint` constraint |

## Notes per variant

**`Unauthorized` now has one source.** It is raised only by `withdraw_capital`,
from an account constraint
(`constraint = lp_position.lp == lp.key() @ FreightDelayError::Unauthorized`).
It previously also guarded `report_delivery_milestone`'s signer; that instruction
was removed with the pull-model change. Note that `settle_policy` does **not** use
this code — an unauthorised settlement fails the signature check and surfaces as
`AttestationRejected`.

**`InvalidAmount` is heavily overloaded.** It covers zero on the way in
(`amount != 0`, `shares != 0`, `payout != 0`, `premium != 0`) and also the case
where a valid input floors to nothing (`shares != 0` after share pricing,
`amount != 0` after redemption pricing). A client seeing 6002 cannot tell which
without inspecting its own arguments.

**`InvalidDeadline` guards the schedule, not the shipment.** It is raised when
`expected_delivery` is not strictly in the future, when `grace_period` is
negative, or when the two do not add up to a deadline inside `MAX_SLA_SECONDS`
(one year) — which also covers a sum that overflows `i64`. The horizon is what
keeps every deadline reachable: without it a buyer could quote `i64::MAX`, or
pair a one-day quote with a grace period of centuries, and the maturity gate
would then be unreachable for the life of the pool, stranding that payout
permanently (pre-freeze audit: unreachable deadline, unbounded grace). Inside the
horizon it says nothing about whether the quoted date is realistic — any future
timestamp and any non-negative slack are accepted as long as the deadline lands
inside it.

**`InvalidPolicyId` keeps the id spendable exactly once.** `buy_policy` requires
`policy_id > PoolConfig.last_policy_id` and no more than `MAX_POLICY_ID_GAP` ahead
of it, then records it. The attester's `nonce` is the policy id, so ids must never
repeat — once a policy's PDA closes its address is free again, and a reused id
would let an attestation signed for the old policy settle the new one on the same
shipment. The window is what stops the counter being spent in one call: a buyer
naming `u64::MAX` would end the id space for every later policy and close the pool
to new business for good.

**`InvalidMint` checks the settlement asset's scale.** `initialize_pool` accepts
only a mint with `decimals == 6`, because every amount the program handles is a
USDC base unit; a mint on another scale would make each premium and payout off by
orders of magnitude. It deliberately says nothing about the mint's authorities:
canonical USDC keeps a live mint and freeze authority with its issuer, so
requiring either to be `None` would reject the asset the pool is denominated in.

**`Insolvent` means capital adequacy.** The message describes locked risk
exceeding total capital, and it is raised both by the `buy_policy` entry gate and
by the closing `assert_solvent()` in all four state-mutating handlers. It is the
code to watch in production — reaching it from `assert_solvent()` would mean a
handler broke the invariant.

**`InsufficientFreeCapital` covers three situations** with one message shaped
around withdrawal: a redemption exceeding free capital, a redemption that would
leave zero free capital while shares remain outstanding (the guard that keeps the
pool usable — see [Invariants](/freight_delay/protocol/invariants)), and a
triggered settlement where capital no longer covers the payout. The
`settle_policy` case is arguably an internal-consistency failure rather than a
withdrawal problem.

**`PolicyNotMature` is the deadline gate.** Settlement is refused until
`Clock::unix_timestamp >= expected_delivery + grace_period`. There is no upper
bound: a policy can be settled at any point after that deadline, and the gate is
satisfied for good once passed, because the clock only moves forward. Until
someone settles, the payout stays in `total_locked_risk`.

**`DeliveryMismatch` now guards a supplied value.** Settlement no longer derives
the attested shipment from an account's seeds; the attestation arrives as
instruction data, so `shipment_id` is caller-supplied and this check is load
bearing. It is raised when `attestation.shipment_id` differs from
`policy.shipment_id`. (Before the pull-model change it was unreachable, because
the report account was seed-derived.)

**`AttestationRejected` is the signature gate.** It is raised in two places: when
`attestation.nonce` is not `policy.policy_id`, and when the ed25519 precompile
scan finds no instruction in the same transaction carrying the configured
`oracle_authority`, the exact 64-byte message — this pool's address followed by
the delivery fields — and the exact signature. One code covers both because the
client fix is the same — obtain a fresh, correctly-bound attestation.

**`MathOverflow` is the catch-all for checked arithmetic.** Every money path
converts `u64 → u128`, applies `checked_*`, and maps failure through
`u64::try_from`. It also absorbs division by zero, so a `checked_div` with a zero
divisor surfaces as 6010 rather than a panic.

## What does *not* produce these codes

Failures from Anchor's own constraint checks bypass `FreightDelayError` entirely:

| Symptom | Actual source |
|---|---|
| Wrong PDA supplied | `ConstraintSeeds` |
| Wrong bump | `ConstraintSeeds` / `ConstraintHasOne` |
| Treasury authority or mint mismatch | `ConstraintTokenOwner` / `ConstraintTokenMint` |
| ATA missing or wrong owner | `AccountNotInitialized` / token program error |
| Policy already initialised, or a pool already exists for the mint | `AccountAlreadyInitialized` |
| Token transfer with insufficient balance | SPL Token error |

When a test asserts `is_err()` without decoding the code, it cannot distinguish
these from a `FreightDelayError`.

## Related

- [Instructions](/freight_delay/protocol/instructions) — the guard order in each handler
- [Events](/freight_delay/reference/events) — including the `DeliveryAttested` record of a settlement
