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
capital-moving handlers (`get_quote` moves none). Because a failing `require!`
reverts the whole transaction, the check is atomic with the mutation.

## Why it holds, handler by handler

`assert_solvent()` is a backstop. The stronger statement is that each handler
preserves the invariant by construction, so the backstop is never the thing
doing the work:

| Handler | Effect on `total_capital` | Effect on `total_locked_risk` | Preservation |
|---|---|---|---|
| `initialize_pool` | `0` | `0` | Trivially holds: `0 <= 0` |
| `deposit_capital` | `+= amount` | unchanged | Capital only grows |
| `get_quote` | `0` | `0` | Creates terms and moves nothing, so it has no `assert_solvent()` |
| `buy_policy` | `+= net_premium` | `+= quote.payout_amount` | Entry gate: `free_capital >= quote.payout_amount`, i.e. `capital - locked >= payout`, so `locked + payout <= capital`. The premium added afterwards only widens the margin |
| `settle_policy` (triggered) | `-= payout` | `-= payout` | Equal subtraction from both sides preserves the ordering |
| `settle_policy` (not triggered) | unchanged | `-= payout` | Risk falls, capital holds |
| `withdraw_capital` | `-= amount` | unchanged | Guard: `amount <= free_capital`, i.e. `amount <= capital - locked`, so `capital - amount >= locked`. The redemption must also leave `free_capital > 0` while `total_shares > 0`, which is the liveness guard below |

Two details make this airtight rather than merely plausible.

**`buy_policy` gates on pre-premium capital.** The entry check
`free_capital() >= payout_amount` runs *before* `net_premium` is credited, so the
gate is conservative: a policy that would fund itself from its own premium is
still rejected if the pool's existing free capital is short. That ordering can
refuse a valid purchase, but it can never admit an invalid one.

**`total_locked_risk` cannot underflow.** `settle_policy` subtracts a policy's
`payout_amount` from the aggregate. That is safe because `total_locked_risk` is
exactly the sum over unsettled policies: `buy_policy` adds each policy's payout
once, and `settle_policy` removes it exactly once (guarded by `is_settled`, and
the policy PDA is closed at settlement, so it can never run twice). No
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

### A pool with shares outstanding always keeps capital free

The primary invariant bounds what a pool owes. A second one keeps it *alive*:

```text
total_shares > 0  =>  free_capital > 0
```

The pressure here comes from `settle_policy`, which subtracts a payout from
`total_capital` and `total_locked_risk` equally, leaving `free_capital`
unchanged. So a triggered settlement is only harmless while the settled payout is
strictly smaller than `total_capital`: settle the last policy of a pool whose
`free_capital` is zero and `total_capital` lands on exactly zero. Every pricing
division in the program divides by `total_capital` (`amount = shares *
total_capital / total_shares` on withdrawal) or by `total_shares`
(`shares = amount * total_shares / total_capital` on deposit), so that state is a
pool nobody can redeem from and nobody can deposit into — permanently, and for
free, since neither step needs a privileged caller (pre-freeze audit: zero-capital brick).

The invariant is inductive over the four handlers that can move it:

| Handler | Effect on `free_capital` | Preservation |
|---|---|---|
| `deposit_capital` | `+= amount` | Capital only grows |
| `get_quote` | unchanged | Moves no capital |
| `buy_policy` | `+= net_premium - quote.payout_amount` | The entry gate is `quote.payout_amount <= free_capital`, so the sum can never dip below `net_premium >= 1` |
| `settle_policy` | unchanged | Equal subtraction from both sides |
| `withdraw_capital` | `-= amount` | Guard: `total_shares == 0 || free_capital > 0` after the burn |

`buy_policy` closing that gate is worth spelling out, because it is the reason
the guard only lives in `withdraw_capital`: a purchase needs
`payout_amount <= free_capital()` *before* the premium is credited, and
`net_premium >= 1` for every admissible fee below `FEE_DENOMINATOR`, so the
purchase leaves at least one base unit of free capital behind. A full exit by the
last LP is the one path that may empty `free_capital` — `total_shares` reaches
zero with it, there is no one left to strand, and the next deposit re-seeds the
pool 1:1.

`is_settled` is checked at the top of `settle_policy` and set to true at the
bottom. A policy therefore releases its locked risk once, whether or not it pays,
and the instruction then closes the policy PDA (CHA-18) — so a second settlement
cannot even load the account, and `PolicyAlreadySettled` is the belt to that
braces. The test suite asserts both.

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
not what releases risk: `buy_policy` requires the deadline
(`expected_delivery + grace_period`) to be in the future and inside
`MAX_SLA_SECONDS`, `settle_policy` requires
`now >= expected_delivery + grace_period`, and the clock is monotonic, so a
policy's deadline is always reachable and that comparison never blocks a matured
policy. But
`settle_policy` also always verifies a signed arrival — early or late — and the
attester reports an absent arrival as `null` rather than inventing a timestamp.
Nothing else in the program can release the payout: its seven instructions contain
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
trigger. `buy_policy` bounds the deadline — quote plus slack — to
`MAX_SLA_SECONDS`, so the slack is always inside what the program can reach, but
nothing checks it against the corridor: a grace period chosen without reference
to the route sells a policy that is very unlikely to pay, and ties up the
collateral it reserves for that whole window. A product-parameter question, not a
program invariant.

**Fee value.** Fees accrue to `total_fees` and are excluded from LP claims and
from `free_capital`. They are also unwithdrawable by any instruction, so the
treasury permanently holds at least `total_fees` in tokens that no party can
claim.

## Related

- [Instructions](/freight_delay/protocol/instructions) — the guards behind each row above
- [Accounts & State](/freight_delay/protocol/accounts) — where the fields live
- [LOI vs Code](/freight_delay/appendix/loi-divergences) — the design document's claims, checked
