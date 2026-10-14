# Events

Nine events, all defined in `events.rs` — one per instruction, with
`settle_policy` emitting three of them. Each
is emitted at the **end** of its handler — after state mutation and after
`assert_solvent()` — so an emitted event is proof that the transaction succeeded
and its effects are durable.

Events are the intended integration surface for indexers: they carry the state a
client needs without requiring account re-reads.

## `PoolInitialized`

```rust
pub struct PoolInitialized {
    pub config: Pubkey,
    pub usdc_mint: Pubkey,
    pub treasury: Pubkey,
    pub admin: Pubkey,
    pub oracle_authority: Pubkey,
    pub keeper: Pubkey,
    pub underwriter: Pubkey,
    pub fee_bps: u16,
}
```

Emitted by `initialize_pool`. Captures the immutable configuration:
`oracle_authority`, `keeper`, `underwriter` and `fee_bps` cannot change later, so
this event is the authoritative record of all four.

## `CapitalDeposited`

```rust
pub struct CapitalDeposited {
    pub config: Pubkey,
    pub lp: Pubkey,
    pub amount: u64,
    pub shares_minted: u64,
    pub total_capital: u64,
}
```

Emitted by `deposit_capital`. `shares_minted` is the floored result of the share
pricing, so a client tracking LP positions can reconcile from events alone
without calling the share formula itself. `total_capital` is read post-mutation.

## `QuoteCreated`

```rust
pub struct QuoteCreated {
    pub config: Pubkey,
    pub quote: Pubkey,
    pub underwriter: Pubkey,
    pub buyer: Pubkey,
    pub quote_id: u64,
    pub shipment_id: u64,
    pub expected_delivery: i64,
    pub grace_period: i64,
    pub payout_amount: u64,
    pub premium_amount: u64,
    pub expires_at: i64,
}
```

Emitted by `get_quote`, the only instruction that names a price. It is the record
of what the seller offered and when the offer lapsed — `buyer` is
`Pubkey::default()` for a quote open to anyone.

This event carries the only copy of the terms that survives a quote nobody
accepts: an unaccepted quote keeps its account, but an expired one is never
acceptable again, and nothing closes it.

## `PolicyPurchased`

```rust
pub struct PolicyPurchased {
    pub config: Pubkey,
    pub policy: Pubkey,
    pub quote: Pubkey,
    pub quote_id: u64,
    pub insured: Pubkey,
    pub policy_id: u64,
    pub shipment_id: u64,
    pub expected_delivery: i64,
    pub grace_period: i64,
    pub payout_amount: u64,
    pub premium_amount: u64,
}
```

Emitted by `buy_policy`. Duplicates the full policy terms, which is the point: an
indexer can build its policy table from events without ever deserialising a
`Policy` account. The effective deadline is `expected_delivery + grace_period`,
and both terms are emitted so it can be computed off chain.

`quote` and `quote_id` are emitted because the quote account is closed by this
very instruction: they are what ties a sale to the offer the seller authored, and
the offer's own terms were emitted by `QuoteCreated`.

Note what is absent — the fee split. `net_premium` and `fee` are derivable from
`premium_amount` and the pool's `fee_bps` (from `PoolInitialized`), but they are
not emitted directly.

## `DeliveryAttested`

```rust
pub struct DeliveryAttested {
    pub config: Pubkey,
    pub policy: Pubkey,
    pub shipment_id: u64,
    pub actual_delivery: i64,
    pub terminal_code: u64,
    pub nonce: u64,
}
```

Emitted by `settle_policy` for every settlement, alongside `PolicySettled`. This
is the **on-chain record of what the oracle attested**: the delivery fact that
resolved the policy.

There is no `reporter` field by design. The evidence for an attestation is the
ed25519 signature `settle_policy` verified, not the identity of a wallet that
submitted a transaction — so the event reports the attested fact rather than who
delivered it.

`nonce` is emitted because it is the within-pool binding: it equals
`policy.policy_id`. Together with the pool key inside the signed message — which
`config` reports — it lets an off-chain reader verify that a recorded attestation
could not have settled any other policy, in this pool or another one.

Note that the delivery is recorded **only** here. Nothing stores it in an
account, so an indexer listening to events is the only way to reconstruct
delivery history on chain — and the attester is the system of record off chain.

## `PolicySettled`

```rust
pub struct PolicySettled {
    pub config: Pubkey,
    pub policy: Pubkey,
    pub insured: Pubkey,
    pub triggered: bool,
    pub payout_amount: u64,
    pub actual_delivery: i64,
    pub expected_delivery: i64,
    pub grace_period: i64,
}
```

Emitted by `settle_policy` on both branches, immediately after `DeliveryAttested`.
`triggered` distinguishes a payout from a risk release, and it is the only event
field that says whether tokens actually moved — `payout_amount` is non-zero even
when `triggered` is false, because it reports the policy term rather than the
transfer.

Pairing the two settlement events gives a complete record: `DeliveryAttested`
says what the oracle attested, `PolicySettled` says what the pool did about it.

A client reconstructing cash flows must read `triggered` before treating
`payout_amount` as a payment. This is the easiest way to misread the event
stream.

## `PolicyClosed`

```rust
pub struct PolicyClosed {
    pub config: Pubkey,
    pub policy: Pubkey,
    pub shipper: Pubkey,
    pub beneficiary: Pubkey,
    pub shipment_id: u64,
    pub expected_delivery: i64,
    pub grace_period: i64,
    pub payout_amount: u64,
    pub premium: u64,
    pub outcome: PolicyOutcome,
    pub decided_at: i64,
    pub decided_at_slot: u64,
}
```

The terminal event, emitted by `settle_policy` immediately before it closes the
`Policy` PDA and returns the rent to the shipper (CHA-18). It carries the full
terms, so a policy's lifecycle stays reconstructible once the account is gone:
this record plus `DeliveryAttested` is the leaf format for the off-chain history
batches, and the chain log remains the availability backstop.

`outcome` is `PaidLate` or `ClosedOnTime`. There is no `PolicyVoided`: the program
has no timeout path (CHA-15), so a policy cannot end any other way.

## `RootPosted`

```rust
pub struct RootPosted {
    pub config: Pubkey,
    pub epoch: u64,
    pub root: [u8; 32],
    pub count: u64,
}
```

Emitted by `post_root` when the keeper posts a history-batch root (CHA-18). The
root is the integrity half of the archive; the `PolicyClosed` events are the
availability half, and they stay in chain history permanently.

## `CapitalWithdrawn`

```rust
pub struct CapitalWithdrawn {
    pub config: Pubkey,
    pub lp: Pubkey,
    pub shares_burned: u64,
    pub amount: u64,
    pub total_capital: u64,
}
```

Emitted by `withdraw_capital`. `shares_burned` is the input, `amount` the floored
redemption value — so the event records the effective share price of the
transaction, which is what an LP's accounting needs.

## Reading events

Anchor events are emitted as `Program data: <base64>` log lines, prefixed with an
8-byte discriminator derived from the event name. A decoder must match on that
discriminator rather than assuming the first `Program data:` line is the one it
wants, because a transaction can emit several events. The test suite does exactly
this in its `parse_event` helper.

## Related

- [Instructions](/freight_delay/protocol/instructions) — where each event is emitted
- [Error Codes](/freight_delay/reference/errors) — the failures that prevent an event from being reached
