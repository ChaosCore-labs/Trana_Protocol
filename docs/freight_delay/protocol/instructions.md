# Instructions

Six instructions. `lib.rs` contains no logic — each `#[program]` function
forwards its arguments and `ctx.bumps` into the handler in the instruction's own
module, where the guards and arithmetic live.

## Guard summary

| Instruction | Signer | Explicit guards | Event |
|---|---|---|---|
| `initialize_pool` | admin | `fee_bps <= 10_000` | `PoolInitialized` |
| `deposit_capital` | lp | `amount != 0`; `shares != 0` | `CapitalDeposited` |
| `buy_policy` | insured | `payout != 0`; `premium != 0`; `expected_delivery > now`; `grace_period >= 0`; `free_capital >= payout` | `PolicyPurchased` |
| `report_delivery_milestone` | oracle authority | `reporter == config.oracle_authority` | `DeliveryReported` |
| `settle_policy` | any (crank) | `!is_settled`; `now >= expected_delivery + grace_period`; delivery fields match policy | `PolicySettled` |
| `withdraw_capital` | lp | `shares != 0`; `shares <= position.shares`; `amount != 0`; `amount <= free_capital` | `CapitalWithdrawn` |

Beyond these, the `#[derive(Accounts)]` structs carry constraints that are just
as load-bearing: `associated_token::authority` on every user token account,
`token::authority = config` and `token::mint = usdc_mint` on the treasury, and
`bump = <account>.bump` pinning already-initialised PDAs to their canonical
address. Failing any of them produces a generic Anchor constraint error rather
than a `FreightDelayError`, which matters when reading test failures.

## `initialize_pool`

Creates `PoolConfig` and the treasury token account.

```rust
pub fn initialize_pool(ctx: Context<InitializePool>, fee_bps: u16, oracle_authority: Pubkey) -> Result<()>
```

- **Guards:** `fee_bps <= FEE_DENOMINATOR as u16`.
- **Creates:** `PoolConfig` at `[b"config", usdc_mint]`, sized `8 + PoolConfig::INIT_SPACE`.
  The treasury is created via the `init` constraint on the token account, with
  `token::authority = config`.
- **Effect:** every accounting field initialised to zero; `admin` is set from the
  signer.
- **Note:** no authority check. The first caller for a given mint becomes the
  pool's admin, and a second call fails on the `init` constraint because the
  `PoolConfig` PDA already exists. `fee_bps = 10_000` (100%) is accepted.
- **Event:** `PoolInitialized { config, usdc_mint, treasury, admin, oracle_authority, fee_bps }`

## `deposit_capital`

Moves USDC into the treasury and mints shares.

```rust
pub fn deposit_capital(ctx: Context<DepositCapital>, amount: u64) -> Result<()>
```

- **Guards:** `amount != 0`, then `shares != 0` after pricing.
- **Share pricing:** `shares = amount` for the first deposit into the pool
  (`total_shares == 0`), otherwise
  `shares = amount * total_shares / total_capital`, floored.
- **Effect:** `lp_position.shares += shares`, `total_shares += shares`,
  `total_capital += amount`, then an SPL `transfer` of `amount` from the LP's ATA
  to the treasury.
- **Account:** `lp_position` uses `init_if_needed` with the zero-filled `lp`
  field as the first-deposit sentinel.
- **Ends with:** `assert_solvent()`.
- **Event:** `CapitalDeposited { config, lp, amount, shares_minted, total_capital }`

The `shares != 0` guard is what stops an economically meaningless deposit: it
rejects an amount so small relative to the pool that it floors to zero shares —
which would otherwise let a depositor give away capital for nothing.

## `buy_policy`

Collects the premium and locks payout risk.

```rust
pub fn buy_policy(
    ctx: Context<BuyPolicy>,
    policy_id: u64,
    shipment_id: u64,
    expected_delivery: i64,
    grace_period: i64,
    payout_amount: u64,
    premium_amount: u64,
) -> Result<()>
```

- **Guards, in order:** `payout_amount != 0`; `premium_amount != 0`;
  `expected_delivery > Clock::unix_timestamp`; `grace_period >= 0`; then
  `free_capital() >= payout_amount`.
- **Fee split:** `fee = premium * fee_bps / 10_000` (floored),
  `net_premium = premium - fee`.
- **Effect:** `total_capital += net_premium`, `total_fees += fee`,
  `total_locked_risk += payout_amount`, SPL transfer of the **gross** premium to
  the treasury, then the `Policy` account is created with `init`.
- **Ends with:** `assert_solvent()`.
- **Event:** `PolicyPurchased { config, policy, insured, policy_id, shipment_id, expected_delivery, grace_period, payout_amount, premium_amount }`

Two ordering facts are deliberate and worth noticing:

The solvency gate reads `free_capital()` **before** the premium is credited, so
the check is conservative — a purchase that would be funded by its own premium
is still refused if the pool's pre-existing free capital is short.

The transfer happens **before** the policy is written, so a buyer who cannot pay
leaves no state behind.

Nothing validates that the quoted `expected_delivery` is realistic, or that
`grace_period` is a sane amount of slack. A policy written with a deadline in
2030 simply locks its payout until 2030.

## `report_delivery_milestone`

Attests a shipment arrival. The only authority-gated instruction.

```rust
pub fn report_delivery_milestone(
    ctx: Context<ReportDeliveryMilestone>,
    shipment_id: u64,
    actual_delivery: i64,
    terminal_code: u64,
) -> Result<()>
```

- **Guard:** `reporter.key() == config.oracle_authority`, else `Unauthorized`.
- **Creates:** `DeliveryReport` at `[b"delivery", shipment_id_le]` with `init`,
  recording `timestamp: Clock::unix_timestamp` and the reporter's key.
- **Effect:** none on pool accounting. No tokens move.
- **Note:** `init` makes each shipment write-once. There is no update or delete
  path, so a mistaken or malicious attestation is permanent. Neither
  `timestamp` nor `terminal_code` is read by any handler.
- **Event:** `DeliveryReported { config, shipment_id, actual_delivery, terminal_code, timestamp, reporter }`

## `settle_policy`

Pays the shipper on a late arrival, or releases the risk. Permissionless.

```rust
pub fn settle_policy(ctx: Context<SettlePolicy>) -> Result<()>
```

- **Guards:** `!policy.is_settled`;
  `Clock::unix_timestamp >= policy.expected_delivery + policy.grace_period`;
  `delivery_report.shipment_id == policy.shipment_id`.
- **Trigger:** `actual_delivery > expected_delivery + grace_period`.
- **Effect, always:** `total_locked_risk -= payout_amount`, `policy.is_settled = true`.
- **Effect, on trigger:** `total_capital -= payout_amount`,
  `policy.is_paid = true`, and `transfer_from_treasury(payout)` to the shipper's ATA.
- **Ends with:** `assert_solvent()`.
- **Event:** `PolicySettled { config, policy, insured, triggered, payout_amount, actual_delivery, expected_delivery, grace_period }`

Notes that are easy to get wrong:

The `delivery_report` account is derived from `policy.shipment_id`, so the
field-equality guard is tautological in practice — the account's seeds already
fix that field. It is defensive, not reachable.

The risk is released on **both** branches. A non-triggered settle leaves
`is_settled = true, is_paid = false` and returns the capital to free capacity.

The deadline is computed at settlement time as
`expected_delivery + grace_period`, with the addition wrapped in `checked_add`.
`now >= deadline` has no upper bound, so a policy can be settled long after the
deadline, and until it is, its payout stays locked.

## `withdraw_capital`

Redeems shares for USDC.

```rust
pub fn withdraw_capital(ctx: Context<WithdrawCapital>, shares: u64) -> Result<()>
```

- **Guards, in order:** `shares != 0`; `shares <= lp_position.shares`;
  `amount != 0`; `amount <= free_capital()`.
- **Pricing:** `amount = shares * total_capital / total_shares`, floored.
- **Effect:** `lp_position.shares -= shares`, `total_shares -= shares`,
  `total_capital -= amount`, then `transfer_from_treasury(amount)` to the LP's ATA.
- **Ends with:** `assert_solvent()`.
- **Event:** `CapitalWithdrawn { config, lp, shares_burned, amount, total_capital }`

The `lp_position` account carries
`constraint = lp_position.lp == lp.key() @ FreightDelayError::Unauthorized` in addition to
the seeds, so a caller cannot redeem against a position that is not theirs even
if they somehow presented the right PDA.

There is no cooldown, no unbonding queue, and no withdrawal cap other than free
capital. Withdrawal is immediate and unconditional once the pool has
unencumbered capital.

## Related

- [Reference: Instructions & Accounts](/freight_delay/reference/instructions) — account lists per instruction
- [Pool Lifecycle](/freight_delay/workflows/lifecycle) — the instructions in sequence
- [Invariants](/freight_delay/protocol/invariants) — the accounting rules these guards protect
