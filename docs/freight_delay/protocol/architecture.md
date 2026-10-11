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
    Attester["Attester<br/>ed25519 keypair"]
    Crank["Crank<br/>any signer"]

    subgraph Program["Program-owned state"]
        Config["PoolConfig"]
        LpPos["LpPosition"]
        Policy["Policy"]
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
    Attester -.->|signs attestation| Crank
    Crank -->|settle_policy| Config
    Crank -->|settle_policy| Policy

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

Solid edges are what each instruction creates or writes. Four of the five write
`PoolConfig`, which is why it is the accounting hub rather than one account among
three. `initialize_pool` is the exception: it creates `PoolConfig` rather than
writing an existing one, and starts the pool at zero risk.

The attester is drawn as a dotted edge because it is **off chain**. It holds an
ed25519 keypair and signs `(shipment_id, actual_delivery, terminal_code, nonce)`;
the crank relays that signature into `settle_policy`, which verifies it against
`PoolConfig.oracle_authority`. No account is written for an arrival — the
attestation exists only inside the settling transaction.

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

Two consequences follow from these shapes, and each is load-bearing:

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

**There is no delivery account at all.** An attested arrival is not state: it is
a signed message verified during settlement. Nothing is written for an arrival,
so there is no account to namespace, no write-once slot, and no stale report to
reason about. The delivery record lives in the `DeliveryAttested` event.

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
├── constants.rs                     # 4 seed literals + FEE_DENOMINATOR
├── error.rs                         # FreightDelayError — 12 flat variants
├── events.rs                        # six events
├── instructions.rs                  # pub mod + pub use registry
├── state.rs                         # PoolConfig, LpPosition, Policy
└── instructions/
    ├── initialize_pool.rs
    ├── deposit_capital.rs
    ├── buy_policy.rs
    ├── settle_policy.rs
    ├── withdraw_capital.rs
    └── shared.rs                    # attestation verification + transfer_from_treasury
```

`lib.rs` contains no logic. Each `#[program]` function forwards its arguments
and `ctx.bumps` into the handler defined in the instruction's own module, which
is where the guards, arithmetic, and event emission live. A new instruction must
be registered in both `lib.rs` and `instructions.rs`.

## Next

- [Accounts & State](/freight_delay/protocol/accounts) — field-by-field layout and space math
- [Instructions](/freight_delay/protocol/instructions) — every handler's guards and effects
- [Invariants](/freight_delay/protocol/invariants) — what the program guarantees, and how
