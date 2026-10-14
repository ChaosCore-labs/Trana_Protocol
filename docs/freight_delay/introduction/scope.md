# Scope & Status

This documentation describes what is in the repository, verified against the
source. It is not a roadmap.

## What this repository contains

```text
Trana_Protocol/
├── freight_delay/
│   ├── programs/freight_delay/
│   │   ├── src/              # the Anchor program
│   │   └── tests/            # LiteSVM integration tests (38 tests)
│   ├── runbooks/             # surfpool / txtx deploy scaffolding
│   └── Anchor.toml
├── mise.toml                 # toolchain pins
├── LOI_DELIVERABLE_FREIGHT_DELAY.md  # design intent (partly stale — see appendix)
└── docs/                     # this site
```

The program is the whole deliverable. There is no frontend, no client SDK, no
indexer, no API service, and no on-chain oracle integration.

## What exists on chain

| Surface | Count | Detail |
|---|---|---|
| Instructions | 7 | `initialize_pool`, `get_quote`, `deposit_capital`, `buy_policy`, `settle_policy`, `withdraw_capital`, `post_root` |
| Account types | 5 | `PoolConfig`, `Quote`, `LpPosition`, `Policy`, `Registry` |
| Error variants | 17 | One flat `FreightDelayError` enum |
| Events | 9 | One per instruction, plus `DeliveryAttested` and `PolicyClosed` |
| Outbound CPIs | 1 | `transfer_from_treasury`, SPL Token `transfer_checked` |

## Where the arrival data comes from

For this project's scope the arrival data is **simulated**. The attester ships
`SimulatedSource` (`attester/src/simulated-source.ts`): a scripted
`shipment_id → arrival` map that goes through the identical sign-and-verify path,
with every result marked `simulated: true` so demo data can never be mistaken for
a carrier's. The walkthrough and the crank both use it.

A real feed is a plug-in, not a protocol change: `ArrivalSource`
(`attester/src/source.ts`) is the seam. Two documented paths reach it — poll a
carrier API (a `Terminal49Source` adapter is written behind the same interface,
though Terminal49's free tier cannot read and it is not part of the pilot) or,
later, bring the data on chain through an oracle. The settlement path is
identical either way, because the program only ever sees a signed payload.

## What is explicitly *not* implemented

Each of these appears in the design document or in a plausible reading of the
protocol, and none of them exists in `src/`:

- **`request_withdrawal` and the 7-day unbonding cooldown.** Withdrawal is
  immediate; there is no `unbonding_shares` or `unbonding_timestamp` field, and
  the string `unbonding` appears nowhere in the program.
- **A `TreasuryVault` account struct.** The treasury is an SPL `TokenAccount`
  owned by the token program with the `PoolConfig` PDA as authority.
- **Any governance or admin setter, including key rotation.** `fee_bps`,
  `oracle_authority`, `keeper` and `underwriter` are fixed at initialisation and
  cannot be changed, and no instruction replaces the attester or the keeper.
  `PoolConfig.admin` is never read. The cost is accepted and has been raised by
  review: a compromised attester key can forge arrivals for the pool's lifetime,
  and a compromised keeper key can post false history roots, with no on-chain
  recovery beyond redeploying the program and migrating the capital. The
  `underwriter` key authors every quote, so a pool's terms are only as honest as
  that key.
- **A Project44 / Spire AIS / Switchboard-TEE oracle integration.** No oracle
  program, no TEE, no HTTP. The program verifies an ed25519 signature from the
  key configured at init (`oracle_authority`), but how that attester obtains the
  arrival is entirely off chain and out of protocol scope — see
  [Where the arrival data comes from](#where-the-arrival-data-comes-from).
- **A fee withdrawal path.** `total_fees` accrues and can never be paid out.
- **A close path for a quote nobody accepts.** `buy_policy` closes the quote it
  accepts; a quote that expires unaccepted keeps its account and rent on chain
  forever, and the underwriter authors the next quote under a new `quote_id`.
- **A refund or timeout for unsettleable policies.** If a shipment is never
  attested, the locked risk is permanent.
- **A crank incentive.** Settlement is permissionless and unpaid.
- **A transfer path for LP shares.** `LpPosition` is seeded by the LP's own key
  (`[lp_position, config, lp]`) and no instruction moves it, so a position cannot
  be sold or transferred, and no token represents a share.
  [RWA & Tokenisation Notes](../appendix/tokenisation) records the idea and what it
  would touch.
- **Any zero-knowledge component.** No circuit, no verifier, no proof-system
  dependency. ZK is being **looked into** as a possible complementary feature —
  for confidential policy terms, or for an arrival attestation that trusts a key
  for less — and is **not planned**. [ZK Research Notes](../appendix/zk-research)
  records where it would attach, what it would cost, and which cheaper options
  come first.

The [LOI vs Code](/freight_delay/appendix/loi-divergences) appendix lists these
divergences against the specific sections of the design document that claim
them.

## Maturity

The program is deployed to **devnet** at
`4BtUosFfNUySEGAGspfjvStCzLzqSRdfoc4Z3Z1uqGJs`
([explorer](https://explorer.solana.com/address/4BtUosFfNUySEGAGspfjvStCzLzqSRdfoc4Z3Z1uqGJs?cluster=devnet)),
as an upgradeable program whose upgrade authority is the deployer's keypair — so
the code can still change under the same program id, and nothing here is a
production commitment. It has never been deployed to mainnet. Because the deploy
reuses the checked-in program keypair, localnet and devnet derive identical
addresses; `Anchor.toml` defaults to `localnet`, so a devnet deploy passes
`--provider.cluster devnet` explicitly.

The build that added `get_quote` grew `PoolConfig` by one key (`underwriter`), so
a pool created by an earlier build has the wrong account size and must be
re-initialised rather than reused. That build is what devnet runs: the program was
upgraded in place on 2026-10-14 (slot `510913195`, ProgramData auto-extended to
330,704 bytes), and every pool the earlier build created is now unreadable.

The devnet walkthrough (`freight_delay/scripts/devnet-e2e.ts`) is the only code here
that spends anything, and it spends nothing of value: it creates its own 6-decimal SPL
token, mints it to itself, and drives the pool with it. That token is not USDC and holds
no value; the program's only requirement on a mint is `decimals == 6`.

Test coverage is 45 tests: 38 LiteSVM integration tests and 7 unit tests of the
ed25519 precompile parsing. The integration suite covers the happy path of every
instruction, the rejection cases, and one regression per finding from the
pre-freeze adversarial audit and the later scan; `bun run devnet-e2e` drives the
deployed program through the whole lifecycle on devnet, asserting the pool's
accounting after each step. The suite passes. It is not a security audit — most
notably, no test asserts a specific error code and no test covers arithmetic
boundaries.

Treat the program as pre-audit. The invariant that matters (full
collateralisation) does hold under the arithmetic as written, and that is argued
in [Invariants](/freight_delay/protocol/invariants) rather than asserted.
