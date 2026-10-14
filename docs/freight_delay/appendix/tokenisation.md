# RWA & Tokenisation Notes

Ideas, not plans. Nothing on this page is implemented, scheduled or decided;
`src/` remains the specification. It is recorded because the idea is worth keeping
and because the accounting decides how cheap it would be.

## The idea

Two related moves would turn this protocol into an issuer of tokenised claims on
physical freight:

- **Turn pool shares into a transferable NAV token.** An LP's position is an
  account today, not a token. Making it a real mint makes underwriting capacity a
  tradeable instrument.
- **Turn a policy into a tokenised claim.** A `Policy` is a PDA that closes when it
  settles. A tokenised version would be a claim on a defined payout.

Either way, what leaves the protocol is a claim on premiums and payouts from
physical freight. That is the same family as a **catastrophe bond**: capital takes
the risk of a parametric trigger for a premium, and what pays is a rule rather
than an adjuster's decision. Insurance-linked securities are counted as real-world
assets, and this is the freight version of one.

## Why the accounting already allows it

The parts a share token has to stay safe around are the aggregates, and the
aggregates do not see holders at all:

| Fact in `src/` | Consequence |
|---|---|
| `deposit_capital` mints `shares = amount * total_shares / total_capital` | the share price is a property of the pool, not of the holder |
| `withdraw_capital` burns shares for `amount = shares * total_capital / total_shares`, gated on `free_capital()` | ownership changes *who* may withdraw, never how much is available |
| `total_shares` and `total_capital` are the only inputs to both | moving shares between holders is accounting-neutral by construction |
| solvency is `total_locked_risk <= total_capital` | unaffected by ownership |

`LpPosition` is seeded `[lp_position, config, lp]`, so a position is bound to one
key, and **no instruction transfers it** — a position cannot be sold today. A share
token would replace the per-LP position account with a balance, and the pool-side
math above would not move. That is why the first move is smaller than it looks.

## What it would touch

- **`LpPosition` stops being the unit of account.** `deposit_capital` and
  `withdraw_capital` would move a mint instead of a PDA, and the
  `init_if_needed` / close-when-empty lifecycle would go with it.
- **The withdrawal gate follows the token, not the person.** A secondary buyer
  inherits it: shares still cannot be redeemed while capital is committed to
  `total_locked_risk`. That is honest for an insurance-linked security and a
  surprise for anyone expecting a liquid fund.
- **A tokenised policy collides with the payout destination.** Settlement pays the
  ATA of the pinned `insured` account and returns the closed policy's rent to that
  same signer. A tradeable claim means the beneficiary is whoever holds the token,
  so the pinned-account design would have to change first — the harder of the two
  moves, and the reason a share token is the natural first step.
- **Provenance.** `PolicyClosed` plus the `Registry` epoch roots are the history of
  who was paid what. Tokenised positions either join that record or leave a gap in
  it.
- **`total_fees` has no withdrawal path.** A NAV token makes that visible as a NAV
  that quietly excludes any fee claim.

## What it would drag in

Calling a product an insurance-linked security also imports what ILSs carry:
disclosure, transfer restrictions, a securities question, and a real-world issuer
behind the token. None of that exists here and none of it is a program feature.
That is the argument for keeping this page a note rather than a task: the decision
is not technical. A pool whose shares trade on a secondary market is a different
object, legally and commercially, from a pool whose shares sit with the LPs who
deposited.

## Status

Idea, not planned and not started: no share mint, no transfer instruction, no
tokenised policy. Recorded because the accounting says the first half is cheap, and
because the constraint that decides it is not in the code.

## Related

- [Accounts & State](../protocol/accounts) — `LpPosition`, `Policy`, `PoolConfig`
- [Invariants](../protocol/invariants) — the aggregates a share token would be neutral to
- [Scope & Status](../introduction/scope) — what exists, and what does not
- [ZK Research Notes](./zk-research) — the other note in this appendix, and why it also stays one
