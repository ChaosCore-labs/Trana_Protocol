# Events

Six events, all defined in `events.rs`. Four are emitted one per state-mutating
instruction, `initialize_pool` has its own, and `settle_policy` emits two. Each
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
    pub fee_bps: u16,
}
```

Emitted by `initialize_pool`. Captures the immutable configuration: neither
`oracle_authority` nor `fee_bps` can change later, so this event is the
authoritative record of both.

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

## `PolicyPurchased`

```rust
pub struct PolicyPurchased {
    pub config: Pubkey,
    pub policy: Pubkey,
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
