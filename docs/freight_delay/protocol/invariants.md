# Invariants

The protocol makes one promise that matters: **every outstanding payout is
backed by capital that exists.** This page states the invariant, shows where it
is enforced, and argues that it survives every handler.

## The primary invariant

```text
total_locked_risk <= total_capital
```

`total_locked_risk` is the sum of `payout_amount` across unsettled policies.
`total_capital` is deposits plus net premiums minus realised payouts. If the
invariant holds, the pool can honour every live policy simultaneously — a
correlated corridor blockage is a loss event, not a solvency event.

It is enforced by `PoolConfig::assert_solvent()`, called at the end of all four
state-mutating handlers. Because a failing `require!` reverts the whole
transaction, the check is atomic with the mutation.

## Why it holds, handler by handler

`assert_solvent()` is a backstop. The stronger statement is that each handler
preserves the invariant by construction, so the backstop is never the thing
doing the work:

| Handler | Effect on `total_capital` | Effect on `total_locked_risk` | Preservation |
|---|---|---|---|
| `initialize_pool` | `0` | `0` | Trivially holds: `0 <= 0` |
| `deposit_capital` | `+= amount` | unchanged | Capital only grows |
| `buy_policy` | `+= net_premium` | `+= payout` | Entry gate: `free_capital >= payout`, i.e. `capital - locked >= payout`, so `locked + payout <= capital`. The premium added afterwards only widens the margin |
| `settle_policy` (triggered) | `-= payout` | `-= payout` | Equal subtraction from both sides preserves the ordering |
| `settle_policy` (not triggered) | unchanged | `-= payout` | Risk falls, capital holds |
| `withdraw_capital` | `-= amount` | unchanged | Guard: `amount <= free_capital`, i.e. `amount <= capital - locked`, so `capital - amount >= locked` |

Two details make this airtight rather than merely plausible.

**`buy_policy` gates on pre-premium capital.** The entry check
`free_capital() >= payout_amount` runs *before* `net_premium` is credited, so the
gate is conservative: a policy that would fund itself from its own premium is
still rejected if the pool's existing free capital is short. That ordering can
refuse a valid purchase, but it can never admit an invalid one.

**`total_locked_risk` cannot underflow.** `settle_policy` subtracts a policy's
`payout_amount` from the aggregate. That is safe because `total_locked_risk` is
exactly the sum over unsettled policies: `buy_policy` adds each policy's payout
once, and `settle_policy` removes it exactly once (guarded by `is_settled`). No
other handler touches the field. The subtraction is nonetheless wrapped in
`checked_sub`, mapping any violation to `MathOverflow` rather than silently
wrapping — the program treats "this should be impossible" as an error, not an
assumption.

## Secondary invariants

### Solvency is inductive from the entry gate

Nothing in the program *forces* the invariant to be restored after a breach,
because a breach is unreachable. Every path either leaves both sides alone, moves
capital up, moves risk down, or moves both sides by exactly the same amount.
There is no handler that raises risk without a matching capital gate, and none
that lowers capital without a matching risk check.

### Conservation of funds

The treasury token balance is fully determined by protocol accounting:

```text
treasury balance = total_capital + total_fees
```

This holds because the only inflow is the gross premium or deposit
(`total_capital += net_premium`, `total_fees += fee`, where
`net_premium + fee = premium`), and the only outflows are payouts and
redemptions, each of which decrements `total_capital` by precisely the amount
transferred. There is no path that moves tokens without a matching accounting
entry, and none that changes accounting without a transfer. An LP can verify the
pool's books against the token account balance at any time by adding the two
fields.

### Share accounting is conserved

`total_shares` is the sum of all `LpPosition.shares` for the pool. Deposits are
the only mint and withdrawals the only burn, so the aggregate and the parts move
together. A position cannot be drained by anyone but its owner: the PDA seeds
`[b"lp_position", config, lp]` bind the position to the signer, and
`withdraw_capital` re-asserts `lp_position.lp == lp.key()`.

### Risk is released exactly once per policy

`is_settled` is checked at the top of `settle_policy` and set to true at the
bottom, and nothing resets it. A policy therefore releases its locked risk once,
whether or not it pays. Double settlement is rejected with
`PolicyAlreadySettled`; the test suite asserts this.

## What the invariant does *not* cover

Full collateralisation means the pool cannot become insolvent through its policy
book. It says nothing about several adjacent risks, which are documented rather
than hidden:

**Price risk on the unit.** "Capital" is a USDC amount, not a real value. Nothing
in the program hedges the stablecoin.

**Oracle correctness.** The invariant bounds *how much* a bad attestation can
move, not *whether* it happens. A malicious authority can trigger every policy it
likes, up to the collateral each one reserves — and because the arrival it writes
is trusted as signed, a false "delivered late" is indistinguishable on chain from
a true one.

**Locked risk is permanent unless an attestation arrives.** An earlier version of
this page claimed the opposite, so it is worth stating exactly. The deadline is
not what releases risk: `buy_policy` requires `expected_delivery > now`,
`settle_policy` requires `now >= expected_delivery + grace_period`, and the clock
is monotonic, so that comparison never blocks a matured policy. But
`settle_policy` also always verifies a signed arrival — early or late — and the
attester reports an absent arrival as `null` rather than inventing a timestamp.
Nothing else in the program can release the payout: its five instructions contain
no timeout, expiry or refund, so `total_locked_risk` only ever falls through a
settlement.

A shipment that is never attested therefore keeps its payout in
`total_locked_risk`, and outside `free_capital`, indefinitely: capital that pays
no one and returns nothing. The invariant still holds — the capital is genuinely
there — but LPs cannot withdraw it, which is the cost [Scope](/freight_delay/introduction/scope)
lists as the deliberate absence of a refund or timeout for unsettleable policies.

That absence is a decision rather than an oversight, and it makes settlement
liveness a first-class operational concern instead of a formality: the trigger is
terminal arrival, and a timeout would pay precisely in the total-loss case where
cargo insurance already indemnifies the same exporter — manufacturing a double
payout rather than covering a gap.

**Grace period versus transit time.** A related trap that is not enforced
on chain: because a delay can only be as large as the transit itself, and ocean
transit runs roughly 15–40 days depending on the corridor, a `grace_period` that
approaches the route's transit time makes a policy that can practically never
trigger. `buy_policy` accepts any non-negative grace period and any future
`expected_delivery`, so this is a product-parameter question rather than a
program invariant — but a grace period chosen without reference to the route
sells a policy that is very unlikely to pay.

**Fee value.** Fees accrue to `total_fees` and are excluded from LP claims and
from `free_capital`. They are also unwithdrawable by any instruction, so the
treasury permanently holds at least `total_fees` in tokens that no party can
claim.

## Related

- [Instructions](/freight_delay/protocol/instructions) — the guards behind each row above
- [Accounts & State](/freight_delay/protocol/accounts) — where the fields live
- [LOI vs Code](/freight_delay/appendix/loi-divergences) — the design document's claims, checked
