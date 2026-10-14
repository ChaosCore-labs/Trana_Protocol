# Instructions

Seven instructions. `lib.rs` contains no logic — each `#[program]` function
forwards its arguments and `ctx.bumps` into the handler in the instruction's own
module, where the guards and arithmetic live.

## Guard summary

| Instruction | Signer | Explicit guards | Event |
|---|---|---|---|
| `initialize_pool` | admin + attester | `fee_bps < 10_000`; `usdc_mint.decimals == 6`; the attester must sign | `PoolInitialized` |
| `deposit_capital` | lp | `amount != 0`; `shares != 0` | `CapitalDeposited` |
| `get_quote` | underwriter | `payout != 0`; `premium != 0`; `expected_delivery > now`; `grace_period >= 0`; `expected_delivery + grace_period <= now + MAX_SLA_SECONDS`; `now < expires_at <= expected_delivery`; `underwriter == config.underwriter` | `QuoteCreated` |
| `buy_policy` | insured | `now <= quote.expires_at`; `quote.buyer == default` or `quote.buyer == insured`; `last_policy_id < policy_id <= last_policy_id + MAX_POLICY_ID_GAP`; `free_capital >= quote.payout_amount` | `PolicyPurchased` |
| `settle_policy` | any (crank) | `!is_settled`; `now >= expected_delivery + grace_period`; attestation matches policy and nonce; ed25519 signature verified | `PolicySettled`, `PolicyClosed` |
| `withdraw_capital` | lp | `shares != 0`; `shares <= position.shares`; `amount != 0`; `amount <= free_capital`; after the burn, `total_shares == 0` or `free_capital > 0` | `CapitalWithdrawn` |
| `post_root` | keeper | `keeper == config.keeper`; the `epoch` PDA must be unposted (`init`) | `RootPosted` |

Beyond these, the `#[derive(Accounts)]` structs carry constraints that are just
as load-bearing: `associated_token::authority` on every user token account,
`token::authority = config` and `token::mint = usdc_mint` on the treasury, and
`bump = <account>.bump` pinning already-initialised PDAs to their canonical
address. Failing any of them produces a generic Anchor constraint error rather
than a `FreightDelayError`, which matters when reading test failures.

## `initialize_pool`

Creates `PoolConfig` and the treasury token account.

```rust
pub fn initialize_pool(
    ctx: Context<InitializePool>,
    fee_bps: u16,
    keeper: Pubkey,
    underwriter: Pubkey,
) -> Result<()>
```

- **Guards:** `fee_bps < FEE_DENOMINATOR`. Below the denominator, not at it: a 100%
  fee floors the net premium to zero, and a pool whose capital can reach zero can
  never be deposited into again, because share pricing divides by it.
- **Mint:** the `usdc_mint` account carries `decimals == 6`, the base unit every
  amount in the program is denominated in. The mint's authorities are deliberately
  not checked: canonical USDC keeps a live mint and freeze authority with its
  issuer, so requiring either to be absent would reject the pool's own asset.
- **Signers:** `admin` pays the rent; `oracle_authority` must also sign, because its
  key is part of the pool's address.
- **Underwriter:** the key allowed to author quotes, written here and immutable
  afterwards. It is deliberately not `oracle_authority`: one key that could both
  name the terms and sign the arrivals could mint a policy and settle it.
  `fee_bps`, `keeper` and `underwriter` are all fixed at initialisation.
- **Creates:** `PoolConfig` at `[b"config", usdc_mint, oracle_authority]`, sized
  `8 + PoolConfig::INIT_SPACE`. The treasury is created via the `init` constraint on
  the token account, with `token::authority = config`.
- **Effect:** every accounting field initialised to zero; `admin` is set from the
  signer, `oracle_authority` from its own signer account, `keeper` and
  `underwriter` from the instruction.
- **Note:** the pool is identified by *(mint, attester)*, so there is no first-caller
  race. Nobody can create the pool belonging to an attester that has not signed for
  it, and nobody can draw deposits to a pool of their own by publishing a different
  attester: the address a client derives for a known attester is unreachable without
  that attester's signature. A second call still fails on the `init` constraint.
- **Event:** `PoolInitialized { config, usdc_mint, treasury, admin, oracle_authority, keeper, underwriter, fee_bps }`

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

## `get_quote`

Authors the terms a policy is later sold on. Only the pool's `underwriter` may
call it, so the price enters the protocol here and nowhere else.

```rust
pub fn get_quote(
    ctx: Context<GetQuote>,
    quote_id: u64,
    shipment_id: u64,
    expected_delivery: i64,
    grace_period: i64,
    payout_amount: u64,
    premium_amount: u64,
    buyer: Pubkey,
    expires_at: i64,
) -> Result<()>
```

- **Signer:** `underwriter`, pinned to `config.underwriter`.
- **Guards, in order:** `payout_amount != 0`; `premium_amount != 0`;
  `expected_delivery > Clock::unix_timestamp`; `grace_period >= 0`;
  `expected_delivery + grace_period <= now + MAX_SLA_SECONDS`, the sum wrapped in
  `checked_add` so an overflowing pair fails here too; then
  `now < expires_at <= expected_delivery`.
- **Creates:** `Quote` at `[b"quote", config, quote_id]`, sized
  `8 + Quote::INIT_SPACE`.
- **Effect:** no capital moves, so there is no `assert_solvent()` here.
- **Event:** `QuoteCreated { config, quote, underwriter, buyer, quote_id, shipment_id, expected_delivery, grace_period, payout_amount, premium_amount, expires_at }`

`buyer` of `Pubkey::default()` leaves the quote open to any buyer; any other
value reserves it. `expires_at` may not outlive `expected_delivery`, so a quote
can never be accepted once the ship is due: without that bound a buyer who
already knew the vessel was late could accept favourable terms and collect. How
much earlier a quote lapses is the underwriter's choice, and it is the only lever
the program gives against a buyer who knows more than the seller.

`expected_delivery + grace_period` is bounded to one year ahead
(`MAX_SLA_SECONDS` from `Clock::unix_timestamp` at authoring time). That bound is
what keeps the settlement deadline reachable: without it a quote could name
`i64::MAX` — or pair an ordinary date with a grace period of centuries — and the
maturity gate (`now >= deadline`) would make the locked payout
unreleasable by anyone, attester included (pre-freeze audit: unreachable deadline,
unbounded grace). Measuring the horizon at authoring time is conservative,
because authoring never happens after purchase.

Inside the horizon nothing validates that the quoted date is realistic: a policy
quoted four months out for a ten-day voyage is accepted. A deadline the corridor's
traffic can never breach is a product-parameter question, not a program guard.

## `buy_policy`

Accepts the underwriter's terms and locks the payout risk.

```rust
pub fn buy_policy(ctx: Context<BuyPolicy>, policy_id: u64, quote_id: u64) -> Result<()>
```

Every term is read from the `Quote` account named by `quote_id`. The buyer
supplies no term at all — no date, no grace, no payout, no premium — so there is
no argument left for a buyer to underprice, and the terms of a sale are the ones
the underwriter authored or none.

- **Guards, in order:** `now <= quote.expires_at`; `quote.buyer ==
  Pubkey::default()` or `quote.buyer == insured`; then `policy_id >
  config.last_policy_id` with
  `policy_id - config.last_policy_id <= MAX_POLICY_ID_GAP`; then
  `free_capital() >= quote.payout_amount`.
- **Fee split:** `fee = quote.premium_amount * fee_bps / 10_000` (floored),
  `net_premium = quote.premium_amount - fee`.
- **Effect:** `total_capital += net_premium`, `total_fees += fee`,
  `total_locked_risk += quote.payout_amount`, SPL transfer of the **gross**
  premium to the treasury, then the `Policy` account is created with `init`.
- **Ends with:** `assert_solvent()`, then the `Quote` PDA is **closed** and its
  rent follows the policy's to the buyer, who pays for the transaction.
- **Event:** `PolicyPurchased { config, policy, quote, quote_id, insured, policy_id, shipment_id, expected_delivery, grace_period, payout_amount, premium_amount }`

Two ordering facts are deliberate and worth noticing:

The solvency gate reads `free_capital()` **before** the premium is credited, so
the check is conservative — a purchase that would be funded by its own premium
is still refused if the pool's pre-existing free capital is short.

The transfer happens **before** the policy is written, so a buyer who cannot pay
leaves no state behind.

Closing the quote is what makes the account, rather than the `quote_id`, the unit
of sale: one quote backs exactly one policy, and a spent quote cannot be presented
again. That is also why the buyer pays no attention to the quote's `underwriter`
field — the address alone proves who authored it, since only
`config.underwriter` could have created that PDA.

Two consequences of that design are worth stating plainly. An expired quote can
never be accepted, and nothing closes it, so its account and rent stay on chain
until the underwriter authors the next quote under a different `quote_id`. And
because ids are caller-chosen, a closed quote's id can be reused for a fresh
quote; the closed PDA, not the id, is what stops a quote backing two policies.

`policy_id` is a nonce, not a label: the attester signs it, and `settle_policy`
requires `nonce == policy_id`. Ids therefore strictly increase per pool and are
never reused — even after the policy's PDA is closed and its address is free
(CHA-18). Reusing one would let a signature minted for the old policy settle the
new one on the same shipment. The step from the previous id is capped at
`MAX_POLICY_ID_GAP`, which is what keeps the space open: the counter only ever
moves up, and without a cap one buyer naming `u64::MAX` would leave no reachable
id for any policy after it.

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

- **Accounts:** the policy PDA, the pool's treasury and the shipper's ATA — plus
  the shipper's own wallet as `insured`, pinned to `policy.insured` because the
  closed policy's rent is paid to it.
- **Guards, in order:** `!policy.is_settled`;
  `Clock::unix_timestamp >= policy.expected_delivery + policy.grace_period`;
  `attestation.shipment_id == policy.shipment_id`;
  `attestation.nonce == policy.policy_id`; then the signature check — the
  instruction sysvar must contain an ed25519 precompile entry over
  `attestation.to_message(&config.key())`, the 64-byte message bound to *this*
  pool, signed by `config.oracle_authority`.
- **Trigger:** `attestation.actual_delivery > expected_delivery + grace_period`,
  where `actual_delivery` is the attested **destination-terminal arrival**
  (`vessel_arrived` / discharged / gate-out), not door delivery. The SLA is
  terminal-to-terminal and the program never infers last-mile.
- **Effect, always:** `total_locked_risk -= payout_amount`, `policy.is_settled = true`.
- **Effect, on trigger:** `total_capital -= payout_amount`,
  `policy.is_paid = true`, and `transfer_from_treasury(payout)` to the shipper's ATA.
- **Ends with:** `assert_solvent()`, then the policy PDA is **closed** and its rent
  returns to the shipper.
- **Event:** `PolicySettled { config, policy, insured, triggered, payout_amount, actual_delivery, expected_delivery, grace_period }`
- **Event:** `PolicyClosed { config, policy, shipper, beneficiary, shipment_id, expected_delivery, grace_period, payout_amount, premium, outcome, decided_at, decided_at_slot }` — the terminal record, emitted immediately before the close.

Notes that are easy to get wrong:

The signed message is 64 bytes: the pool's address, then `shipment_id`,
`actual_delivery`, `terminal_code` and `nonce`. `actual_delivery` is the
**destination-terminal arrival** timestamp in unix seconds, and `terminal_code`
names the terminal it was measured at. Two bindings come out of it, and
they stop different attacks.

The pool prefix stops **cross-pool** replay. Without it a signature travels
between pools that share an attester, because `nonce` is checked against a policy
id the *buyer* chooses and every pool numbers its policies from zero: a captured
signature would settle a policy the attester never saw.

The `nonce` is the **within-pool** defence. It is part of the signed message, and
the handler requires `nonce == policy.policy_id`, so a signature can only ever
settle the policy it was minted for; `is_settled` blocks a second settlement, and
the PDA is closed after the first, so a replay cannot even load the account.

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

Given an attested arrival, the risk is released on **both** branches, and either
branch closes the policy PDA: `PolicyClosed.outcome` is `PaidLate` or
`ClosedOnTime`. A non-triggered settle transfers nothing and returns the capital
to free capacity.

The deadline is computed at settlement time as
`expected_delivery + grace_period`, with the addition wrapped in `checked_add`.
Purchase already refused any pair whose sum does not land inside `MAX_SLA_SECONDS`
— which also covers a sum that overflows `i64` — so the addition never fails here
and the deadline is always reachable. The comparison itself needs no upper bound: the
clock is monotonic, and the gate stays satisfied once the deadline passes. Passing the
deadline releases nothing on its own, though. Settlement still requires a signed
arrival, and no instruction expires a policy, so a shipment that is never
attested leaves its payout in `total_locked_risk` permanently — what such a
policy lacks is an attestation, not a crank. See
[Invariants](/freight_delay/protocol/invariants).

## `withdraw_capital`

Redeems shares for USDC.

```rust
pub fn withdraw_capital(ctx: Context<WithdrawCapital>, shares: u64) -> Result<()>
```

- **Guards, in order:** `shares != 0`; `shares <= lp_position.shares`;
  `amount != 0`; `amount <= free_capital()`; then, after the burn,
  `total_shares == 0 || free_capital() > 0`.
- **Pricing:** `amount = shares * total_capital / total_shares`, floored.
- **Effect:** `lp_position.shares -= shares`, `total_shares -= shares`,
  `total_capital -= amount`, then `transfer_from_treasury(amount)` to the LP's ATA.
- **Ends with:** `assert_solvent()`.
- **Event:** `CapitalWithdrawn { config, lp, shares_burned, amount, total_capital }`

The `lp_position` account carries
`constraint = lp_position.lp == lp.key() @ FreightDelayError::Unauthorized` in addition to
the seeds, so a caller cannot redeem against a position that is not theirs even
if they somehow presented the right PDA.

There is no cooldown, no unbonding queue, and no withdrawal ceiling other than
free capital. Withdrawal is immediate and unconditional once the pool has
unencumbered capital — but a redemption may not take the last of it while shares
are still outstanding.

The reason is liveness, not solvency. A redemption can legally empty
`free_capital` while a payout is still locked; the settlement that follows then
subtracts that payout from a `total_capital` sitting exactly on the locked risk,
and the last trigger drives it to zero. Both pricing divisions then divide by
zero — `amount = shares * total_capital / total_shares` on the way out,
`shares = amount * total_shares / total_capital` on the way in — so nobody could
redeem and nobody could ever deposit into that pool again. It is a permanent,
free denial of service on the whole pool, and it needs no privileged caller
(pre-freeze audit: zero-capital brick).

The guard costs one base unit of liquidity: at least 0.000001 USDC of free
capital always stays behind while shares exist. A full exit is exempt, because
`total_shares == 0` means there is nobody left to strand — and a pool brought to
zero that way restarts cleanly, since the first deposit into an empty share book
prices 1:1.

## `post_root`

Posts one history-batch root. Keeper-signed; one `Registry` PDA per epoch.

```rust
pub fn post_root(ctx: Context<PostRoot>, epoch: u64, root: [u8; 32], count: u64) -> Result<()>
```

- **Guards:** `keeper == config.keeper`; the `[b"registry", config, epoch]` PDA must
  be unposted (`init`).
- **Effect:** writes `Registry { epoch, root, count }`.
- **Event:** `RootPosted { config, epoch, root, count }`

The program does not verify the Merkle root — it cannot, on chain. It authenticates
the poster and stores the root; anyone holding the batch data checks inclusion
against it. A withheld batch is undetectable, which is the residual trust the
design accepts (see [Invariants](/freight_delay/protocol/invariants)).

## Related

- [Reference: Instructions & Accounts](/freight_delay/reference/instructions) — account lists per instruction
- [Pool Lifecycle](/freight_delay/workflows/lifecycle) — the instructions in sequence
- [Invariants](/freight_delay/protocol/invariants) — the accounting rules these guards protect
