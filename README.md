# Freight Delay

A parametric freight-delay indemnity protocol on Solana.

One pool per USDC mint. Liquidity providers deposit USDC and receive shares.
Shippers buy a policy that pays out when the attested arrival for their shipment
lands past the quoted delivery time plus a grace period. A single oracle
authority writes those delivery milestones, and settlement is permissionless —
anyone can crank it once a policy's deadline has passed.

The pool is **fully collateralised at all times**: every outstanding payout is
backed by capital the pool already holds, and that invariant is re-checked after
every state change.

This repository holds the Anchor program and its documentation site. There is
no frontend, SDK, or indexer.

Program ID: `4BtUosFfNUySEGAGspfjvStCzLzqSRdfoc4Z3Z1uqGJs`

## Layout

```text
.
├── freight_delay/             # the freight-delay Anchor program and its tests
├── docs/                      # the documentation site
├── LOI_DELIVERABLE_FREIGHT_DELAY.md  # the program's design intent
├── mise.toml                  # pinned toolchain (agave, anchor fork, surfpool, nextest, sccache, bun)
├── rust-toolchain.toml        # pinned Rust channel + components
└── .cargo/config.toml         # sccache as the rustc wrapper
```

`mise.toml`, `rust-toolchain.toml`, and `.cargo/config.toml` live at the root and
apply to the program.

Each directory documents itself:

- **[`freight_delay/README.md`](freight_delay/README.md)** — the program:
  layout, toolchain, build and test, the instruction set, accounts, accounting
  rules, and what the program deliberately does not do.
- **[`docs/README.md`](docs/README.md)** — the documentation site: how to run it,
  the section structure, the theming, how diagrams are rendered, and the checks
  it runs.

## Quick start

```bash
mise trust                  # once per clone: mise gates config files by path
mise install                 # agave, anchor, surfpool, nextest, sccache, bun

cd freight_delay
anchor build                 # -> target/deploy/freight_delay.so
cargo nextest run            # 29 tests: 22 LiteSVM + 7 unit

# The documentation site.
cd ../docs
bun install
bun run dev                  # http://localhost:5173
```

`anchor build` must run before the tests: they load `target/deploy/freight_delay.so`
at compile time, so a stale build silently tests old code.

## Reading the documentation

The docs site is the reference for the protocol, split into one top-level
section with its own left-hand tree. Pages worth knowing first:

- `docs/freight_delay/protocol/instructions.md` — every instruction with its full
  guard list
- `docs/freight_delay/protocol/invariants.md` — the accounting rules the program
  enforces
- `docs/freight_delay/appendix/loi-divergences.md` — what the program
  deliberately does not implement

## A note on the design document

`LOI_DELIVERABLE_FREIGHT_DELAY.md` is the original proposal, **not** a
specification. It describes features that were never built — a withdrawal
cooldown, a `TreasuryVault` account, governance setters for the fee and oracle
authority, and Switchboard TEE oracles. Read it for vocabulary; treat
`freight_delay/programs/freight_delay/src` as the truth, and see the
`appendix/` page for the divergences.
