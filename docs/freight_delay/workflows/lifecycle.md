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
    participant Report as DeliveryReport
    actor Oracle as Oracle Authority
    actor Crank

    rect rgb(137, 180, 130, 0.12)
    Note over Admin, Treasury: Stage 1 — pool creation
    Admin->>Program: initialize_pool(fee_bps, oracle)
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
    Note over Oracle, Report: Stage 4 — arrival attestation
    Oracle->>Program: report_delivery_milestone(shipment, arrival, terminal)
    Program->>Program: require reporter == oracle_authority
    Program->>Report: init with actual_delivery and timestamp
    Program-->>Oracle: DeliveryReported
    end

    rect rgb(137, 180, 130, 0.12)
    Note over Crank, Shipper: Stage 5 — settlement
    Crank->>Program: settle_policy()
    Program->>Program: require mature and unsettled
    Program->>Program: release locked risk
    alt arrived after the deadline
        Program->>Program: capital -= payout
        Program->>Treasury: transfer payout
        Treasury-->>Shipper: USDC
    else arrived within grace
        Note over Program: no transfer
    end
    Program->>Program: mark settled
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
holds capital, and more capital can arrive while policies are live. Stage 4 must
precede stage 5 for a given `shipment_id` — `settle_policy` requires the
`DeliveryReport` account to exist, and there is no fallback if it does not.

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

`report_delivery_milestone` is deliberately absent from this diagram: it creates a
`DeliveryReport` and cannot move pool accounting at all — `config` is not even
`mut` in its account list, so it only reads `oracle_authority` to authorise the
caller.

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
`Placed` is terminal in practice for any policy whose shipment is never attested:
`settle_policy` needs the `DeliveryReport` account to exist, so the transition
never becomes available.

## Instruction dependency graph

```mermaid
flowchart TD
    Init["initialize_pool"] --> Dep["deposit_capital"]
    Init --> Report["report_delivery_milestone"]
    Dep --> Buy["buy_policy"]
    Buy --> Settle["settle_policy"]
    Report --> Settle
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
