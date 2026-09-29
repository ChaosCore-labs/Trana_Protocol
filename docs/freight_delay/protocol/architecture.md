# Architecture

Freight Delay is a single Anchor program. Every piece of state is a program-derived
address (PDA), every value transfer is an SPL Token CPI, and the only account
the program ever signs for is the pool treasury.

## Component map

```mermaid
flowchart LR
    Admin["Admin"]
    LP["Liquidity Provider"]
    Shipper["Shipper / Exporter"]
    Oracle["Oracle Authority"]
    Crank["Crank<br/>any signer"]

    subgraph Program["Program-owned state"]
        Config["PoolConfig"]
        LpPos["LpPosition"]
        Policy["Policy"]
        Report["DeliveryReport"]
    end

    subgraph Token["SPL token accounts"]
        Mint["USDC mint"]
        Treasury["Treasury<br/>authority = PoolConfig"]
        LpAta["LP USDC"]
        ShipperAta["Shipper USDC"]
    end

    Admin -->|initialize_pool| Config
    Admin -->|initialize_pool| Treasury
    LP -->|deposit_capital| Config
    LP -->|deposit_capital| LpPos
    LP -->|withdraw_capital| Config
    LP -->|withdraw_capital| LpPos
    Shipper -->|buy_policy| Config
    Shipper -->|buy_policy| Policy
    Oracle -->|report_delivery_milestone| Report
    Crank -->|settle_policy| Config
    Crank -->|settle_policy| Policy
    Crank -.->|reads| Report

    Config -.->|authority| Treasury
    Mint -.->|namespaces| Config
    Mint -.->|mint| Treasury
    Mint -.->|mint| LpAta
    Mint -.->|mint| ShipperAta

    LpAta -.->|deposit| Treasury
    ShipperAta -.->|premium| Treasury
    Treasury -.->|payout| ShipperAta
    Treasury -.->|redemption| LpAta
```

Solid edges are what each instruction creates or writes. Five of the six write
`PoolConfig`, which is why it is the accounting hub rather than one account among
four. `report_delivery_milestone` is the exception: it reads `config` only, to
check the reporter against `oracle_authority`, and moves no tokens.

Dotted arrows are the token movements and the two structural links the program
rests on: the treasury's authority is the `PoolConfig` PDA, and `PoolConfig`
itself is namespaced by the USDC mint, which is also the mint of the other three
token accounts. Transfers are drawn as flows rather than repeated as one edge per
instruction — the token accounts a handler takes as `mut` are exactly the
counterparties of those four legs.

## PDA derivation

| Account | Seeds | Owner | Signer authority |
|---|---|---|---|
| `PoolConfig` | `[b"config", usdc_mint]` | Freight Delay program | — |
| treasury | `[b"treasury", config]` | SPL Token program | `PoolConfig` PDA |
| `LpPosition` | `[b"lp_position", config, lp]` | Freight Delay program | — |
| `Policy` | `[b"policy", config, policy_id_le]` | Freight Delay program | — |
| `DeliveryReport` | `[b"delivery", shipment_id_le]` | Freight Delay program | — |

Three consequences follow from these shapes, and each is load-bearing:

**The pool is namespaced by mint.** `PoolConfig` derives from the USDC mint, so
one mint gets one pool, and nothing in the program has to check for a duplicate
pool — the `init` constraint on `[b"config", usdc_mint]` makes a second
initialisation of the same mint fail at the runtime level.

**The treasury is a token account owned by a PDA.** It is not a program-owned
data account but an SPL `TokenAccount` whose authority is the `PoolConfig` PDA.
The program holds no private key; it can only move those funds by producing the
`[b"config", usdc_mint, bump]` seeds during a CPI, which is exactly what
`transfer_from_treasury` does. This is why an arbitrary caller cannot drain the
pool even if a handler forgot a signer check — the token program itself rejects
the transfer.

**`DeliveryReport` is deliberately not namespaced by pool.** A report is keyed by
`shipment_id` alone, so a shipment's arrival is a single global fact shared by
every pool that reads it. That is a design choice with a real consequence:
reports cannot be created twice, and one authority's observation serves all
pools. See [LOI vs Code](/freight_delay/appendix/loi-divergences).

## The single outbound CPI

`instructions/shared.rs` holds the only function in the program that signs with
program-derived seeds:

```rust
pub fn transfer_from_treasury<'info>(
    token_program: &Program<'info, Token>,
    treasury: &Account<'info, TokenAccount>,
    recipient: &Account<'info, TokenAccount>,
    config: &Account<'info, PoolConfig>,
    amount: u64,
) -> Result<()> {
    let seeds: &[&[u8]] = &[CONFIG_SEED, config.usdc_mint.as_ref(), &[config.bump]];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    transfer(
        CpiContext::new_with_signer(
            token_program.key(),
            Transfer {
                from: treasury.to_account_info(),
                to: recipient.to_account_info(),
                authority: config.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )
}
```

Exactly two instructions call it: `settle_policy` (payout to the shipper) and
`withdraw_capital` (redemption to the LP). Both destinations are constrained at
the account level — the payout account is an ATA owned by `policy.insured`, and
the redemption account is an ATA owned by the `lp` signer. Neither destination
is caller-supplied arbitrary.

## Module layout

```text
programs/freight_delay/src/
├── lib.rs                           # declare_id!, #[program] mod freight_delay — forwarding only
├── constants.rs                     # 5 seed literals + FEE_DENOMINATOR
├── error.rs                         # FreightDelayError — 11 flat variants
├── events.rs                        # one event per instruction
├── instructions.rs                  # pub mod + pub use registry
├── state.rs                         # PoolConfig, LpPosition, Policy, DeliveryReport
└── instructions/
    ├── initialize_pool.rs
    ├── deposit_capital.rs
    ├── buy_policy.rs
    ├── report_delivery_milestone.rs
    ├── settle_policy.rs
    ├── withdraw_capital.rs
    └── shared.rs                    # transfer_from_treasury
```

`lib.rs` contains no logic. Each `#[program]` function forwards its arguments
and `ctx.bumps` into the handler defined in the instruction's own module, which
is where the guards, arithmetic, and event emission live. A new instruction must
be registered in both `lib.rs` and `instructions.rs`.

## Next

- [Accounts & State](/freight_delay/protocol/accounts) — field-by-field layout and space math
- [Instructions](/freight_delay/protocol/instructions) — every handler's guards and effects
- [Invariants](/freight_delay/protocol/invariants) — what the program guarantees, and how
