# Pool Lifecycle

The whole protocol, from initialisation to settlement, in the order it happens.

## End-to-end sequence

```mermaid
sequenceDiagram
    autonumber
    actor Admin
    actor LP as Liquidity Provider
    actor Shipper
    participant Program as Freight Delay program
    participant Treasury as Treasury
    actor Attester as Attester (off chain)
    actor Crank

    rect rgb(137, 180, 130, 0.12)
    Note over Admin, Treasury: Stage 1 — pool creation
    Admin->>Program: initialize_pool(fee_bps) + attester signature
    Program->>Treasury: init, authority = PoolConfig
    Program-->>Admin: PoolInitialized
    end

    rect rgb(137, 180, 130, 0.12)
    Note over LP, Treasury: Stage 2 — underwriting capital
    LP->>Program: deposit_capital(amount)
    Program->>Program: price and mint shares
    Program->>Treasury: transfer USDC
    Program-->>LP: CapitalDeposited
    end

    rect rgb(137, 180, 130, 0.12)
    Note over Shipper, Treasury: Stage 3 — hedge placement
    Shipper->>Program: buy_policy(terms)
    Program->>Program: require free_capital >= payout
    Program->>Program: credit net premium, lock payout risk
    Program->>Treasury: transfer premium
    Program-->>Shipper: PolicyPurchased
    end

    rect rgb(137, 180, 130, 0.12)
    Note over Attester: Stage 4 — arrival attestation (off chain)
    Attester->>Attester: sign (pool, shipment, arrival, terminal, nonce)
    Note over Attester: no transaction, no account
    end

    rect rgb(137, 180, 130, 0.12)
    Note over Crank, Shipper: Stage 5 — settlement
    Crank->>Program: settle_policy(attestation, signature)
    Crank->>Program: ed25519 precompile instruction
    Program->>Program: require mature and unsettled
    Program->>Program: require pool prefix, nonce == policy_id, shipment matches
    Program->>Program: verify signature against oracle_authority
    Program->>Program: release locked risk
    alt arrived after the deadline
        Program->>Program: capital -= payout
        Program->>Treasury: transfer payout
        Treasury-->>Shipper: USDC
    else arrived within grace
        Note over Program: no transfer
    end
    Program->>Program: mark settled
    Program-->>Crank: DeliveryAttested
    Program-->>Crank: PolicySettled
    end

    rect rgb(137, 180, 130, 0.12)
    Note over LP, Treasury: Stage 6 — redemption
    LP->>Program: withdraw_capital(shares)
    Program->>Program: require amount <= free_capital
    Program->>Program: burn shares, capital -= amount
    Program->>Treasury: transfer USDC
    Treasury-->>LP: USDC
    Program-->>LP: CapitalWithdrawn
    end
```

Stages 2 and 3 can interleave freely: policies can be sold the moment the pool
holds capital, and more capital can arrive while policies are live.

Stage 4 is deliberately not a transaction. The attester signs the arrival and
stops; nothing is written on chain until a crank relays that signature during
settlement. So the signature is not a prerequisite step so much as an input to
stage 5.

Stage 5 is permissionless but not automatic. Nothing calls `settle_policy` on
its own, so a policy waits for a crank — and its payout stays in
`total_locked_risk`, outside `free_capital`, until one runs. Every policy does
become settleable once its deadline passes, so this is a liveness concern rather
than a stranded-capital one; see [Invariants](/freight_delay/protocol/invariants)
for why.

## Pool state machine

```mermaid
stateDiagram-v2
    [*] --> Unfunded
    Unfunded --> Funded : initialize_pool
    Unfunded --> Funded : deposit_capital
    Funded --> Funded : deposit_capital
    Funded --> Funded : buy_policy
    Funded --> Funded : settle_policy
    Funded --> Funded : withdraw_capital
    Funded --> Unfunded : withdraw_capital empties total_capital
```

Every instruction that touches the pool appears here. There is no
attestation-only instruction any more: an arrival reaches the program purely as
instruction data to `settle_policy`.

There is no terminal or frozen state. The pool has no pause, no shutdown, and no
migration path; it is a permanent state machine.

## Policy state machine

```mermaid
stateDiagram-v2
    [*] --> Placed : buy_policy
    Placed --> Late : settle_policy, arrival past the deadline
    Placed --> OnTime : settle_policy, arrival at or before the deadline
    Late --> [*]
    OnTime --> [*]
```

`Late` and `OnTime` are both terminal, distinguished by the `is_paid` flag.

`Placed` is the transient state. Both transitions out of it require a valid
signed attestation, but every policy acquires one option to leave: once
`now >= expected_delivery + grace_period`, any attested arrival — early or late —
is enough, and a non-triggering arrival still releases the locked risk. A policy
sits in `Placed` only until a crank settles it.

The state machine has no timeout edge, by design: the trigger is terminal
arrival, and a timeout would pay in the total-loss case that cargo insurance
already covers.

## Instruction dependency graph

```mermaid
flowchart TD
    Init["initialize_pool"] --> Dep["deposit_capital"]
    Dep --> Buy["buy_policy"]
    Buy --> Settle["settle_policy"]
    Dep --> With["withdraw_capital"]
    Settle -.->|frees locked risk| With
```

Read the dotted edge as the only coupling between settlement and redemption:
`settle_policy` lowers `total_locked_risk`, which raises `free_capital`, which is
the ceiling on `withdraw_capital`. Until policies settle, LP capital is not fully
withdrawable.

## Next

- [Instructions](/freight_delay/protocol/instructions) — the guards at each step
- [Invariants](/freight_delay/protocol/invariants) — what settlement must preserve
