# Instructions

Five instructions. `lib.rs` contains no logic — each `#[program]` function
forwards its arguments and `ctx.bumps` into the handler in the instruction's own
module, where the guards and arithmetic live.

## Guard summary

| Instruction | Signer | Explicit guards | Event |
|---|---|---|---|
| `initialize_pool` | admin + attester | `fee_bps < 10_000`; the attester must sign | `PoolInitialized` |
| `deposit_capital` | lp | `amount != 0`; `shares != 0` | `CapitalDeposited` |
| `buy_policy` | insured | `payout != 0`; `premium != 0`; `expected_delivery > now`; `grace_period >= 0`; `expected_delivery + grace_period` representable; `free_capital >= payout` | `PolicyPurchased` |

| `settle_policy` | any (crank) | `!is_settled`; `now >= expected_delivery + grace_period`; attestation matches policy and nonce; ed25519 signature verified | `PolicySettled` |
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
pub fn initialize_pool(ctx: Context<InitializePool>, fee_bps: u16) -> Result<()>
```

- **Guards:** `fee_bps < FEE_DENOMINATOR`. Below the denominator, not at it: a 100%
  fee floors the net premium to zero, and a pool whose capital can reach zero can
  never be deposited into again, because share pricing divides by it.
- **Signers:** `admin` pays the rent; `oracle_authority` must also sign, because its
  key is part of the pool's address.
- **Creates:** `PoolConfig` at `[b"config", usdc_mint, oracle_authority]`, sized
  `8 + PoolConfig::INIT_SPACE`. The treasury is created via the `init` constraint on
  the token account, with `token::authority = config`.
- **Effect:** every accounting field initialised to zero; `admin` is set from the
  signer, `oracle_authority` from its own signer account.
- **Note:** the pool is identified by *(mint, attester)*, so there is no first-caller
  race. Nobody can create the pool belonging to an attester that has not signed for
  it, and nobody can draw deposits to a pool of their own by publishing a different
  attester: the address a client derives for a known attester is unreachable without
  that attester's signature. A second call still fails on the `init` constraint.
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

## `settle_policy`

Pays the shipper on a late arrival, or releases the risk. Permissionless.

```rust
pub fn settle_policy(
    ctx: Context<SettlePolicy>,
    attestation: DeliveryAttestation,
    signature: [u8; 64],
) -> Result<()>
```

The delivery fact arrives as **instruction data**, not as an account: a caller
supplies the attested shipment and its ed25519 signature, and must also include
the ed25519 precompile instruction that carries that signature, earlier in the
same transaction.

- **Guards, in order:** `!policy.is_settled`;
  `Clock::unix_timestamp >= policy.expected_delivery + policy.grace_period`;
  `attestation.shipment_id == policy.shipment_id`;
  `attestation.nonce == policy.policy_id`; then the signature check — the
  instruction sysvar must contain an ed25519 precompile entry over
  `attestation.to_message(&config.key())`, the 64-byte message bound to *this*
  pool, signed by `config.oracle_authority`.
- **Trigger:** `attestation.actual_delivery > expected_delivery + grace_period`.
- **Effect, always:** `total_locked_risk -= payout_amount`, `policy.is_settled = true`.
- **Effect, on trigger:** `total_capital -= payout_amount`,
  `policy.is_paid = true`, and `transfer_from_treasury(payout)` to the shipper's ATA.
- **Ends with:** `assert_solvent()`.
- **Event:** `PolicySettled { config, policy, insured, triggered, payout_amount, actual_delivery, expected_delivery, grace_period }`

Notes that are easy to get wrong:

The signed message is 64 bytes: the pool's address, then `shipment_id`,
`actual_delivery`, `terminal_code` and `nonce`. Two bindings come out of it, and
they stop different attacks.

The pool prefix stops **cross-pool** replay. Without it a signature travels
between pools that share an attester, because `nonce` is checked against a policy
id the *buyer* chooses and every pool numbers its policies from zero: a captured
signature would settle a policy the attester never saw.

The `nonce` is the **within-pool** defence. It is part of the signed message, and
the handler requires `nonce == policy.policy_id`, so a signature can only ever
settle the policy it was minted for; `is_settled` then blocks settling that
policy a second time.

The signature check is a *scan*, not a cryptographic call. It reads the
instruction sysvar, walks the instructions before `settle_policy`, and accepts
only an ed25519 precompile entry that carries exactly this message, this
signature, and `config.oracle_authority` inline. A valid signature that is never
submitted to the precompile is therefore not enough — the bytes the precompile
checked must be the ones the handler was handed.

It does **not** prevent replay, and it is worth being precise about why. The
precompile is deterministic: resubmitting the same signature bytes in a later
transaction produces another precompile entry that passes this scan again. The
scan binds a signature to a *transaction*, not to a point in time.

Replay within a pool is stopped by the `nonce`, and replay across pools by the
pool prefix — see above. What the scan adds is *relevance*: the signature must
have been checked by the precompile in this very transaction.

The risk is released on **both** branches. A non-triggered settle leaves
`is_settled = true, is_paid = false` and returns the capital to free capacity.

The deadline is computed at settlement time as
`expected_delivery + grace_period`, with the addition wrapped in `checked_add`.
A pair whose sum is not representable is rejected at purchase, so the addition
never fails here: the comparison needs no upper bound because the clock is
monotonic, and the gate stays satisfied once the deadline passes. Every policy
therefore has a settlement path; what it may lack is a crank to take it.

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
