# PDA Seeds & Constants

Every address the program derives comes from the seed literals in `constants.rs`.
Matching these exactly is mandatory for any client — a wrong seed produces a
valid-looking but wrong account.

```rust
#[constant]
pub const CONFIG_SEED: &[u8] = b"config";

#[constant]
pub const TREASURY_SEED: &[u8] = b"treasury";

#[constant]
pub const LP_POSITION_SEED: &[u8] = b"lp_position";

#[constant]
pub const POLICY_SEED: &[u8] = b"policy";

#[constant]
pub const REGISTRY_SEED: &[u8] = b"registry";

/// Basis-point denominator for `PoolConfig::fee_bps` (1 bp = 1/100 of 1%).
#[constant]
pub const FEE_DENOMINATOR: u64 = 10_000;

/// Bound on where a policy's deadline (`expected_delivery + grace_period`) may
/// land, measured from purchase. An unreachable deadline makes the payout
/// unreleasable, and there is no timeout.
#[constant]
pub const MAX_SLA_SECONDS: i64 = 365 * 24 * 60 * 60;

/// Decimals the settlement mint must use: every amount in this program is USDC.
#[constant]
pub const USDC_DECIMALS: u8 = 6;

/// How far ahead of a pool's counter a buyer may place a `policy_id`: room for
/// concurrent quotes to pick distinct ids, far too narrow to spend a u64.
#[constant]
pub const MAX_POLICY_ID_GAP: u64 = 10_000;
```

These are declared with `#[constant]` rather than bare `pub const` so they are
emitted into the IDL and visible to clients.

## Derivation table

| Account | Seeds | Notes |
|---|---|---|
| `PoolConfig` | `[b"config", usdc_mint, oracle_authority]` | One pool per (mint, attester) |
| treasury | `[b"treasury", config]` | SPL `TokenAccount`, authority = `PoolConfig` PDA |
| `LpPosition` | `[b"lp_position", config, lp]` | Bound to the LP's key |
| `Policy` | `[b"policy", config, policy_id_le]` | `policy_id` little-endian |
| `Registry` | `[b"registry", config, epoch_le]` | `epoch` little-endian; one root per epoch |

The program id is `4BtUosFfNUySEGAGspfjvStCzLzqSRdfoc4Z3Z1uqGJs`.

::: danger Seed literals are frozen
Changing any literal, or the byte encoding of a `u64` argument, changes every
derived address and orphans all live accounts. Arguments are positional, so
reordering instruction parameters is equally destructive.
:::

## Integer encoding

`policy_id`, `shipment_id` and `epoch` are `u64` and enter the seeds as
little-endian bytes — the same encoding as `.to_le_bytes()` in Rust and
`BigInt64`-style little-endian writers in clients.

## Client derivation

With `@solana/kit`:

```ts
import { getProgramDerivedAddress, getAddressEncoder, address } from '@solana/kit'

const PROGRAM_ID = address('4BtUosFfNUySEGAGspfjvStCzLzqSRdfoc4Z3Z1uqGJs')
const encoder = getAddressEncoder()
const bytes = (n: bigint): Uint8Array => {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, n, true) // little-endian
  return out
}

const [config] = await getProgramDerivedAddress({
  programAddress: PROGRAM_ID,
  seeds: ['config', encoder.encode(usdcMint)],
})

const [treasury] = await getProgramDerivedAddress({
  programAddress: PROGRAM_ID,
  seeds: ['treasury', encoder.encode(config)],
})

const [lpPosition] = await getProgramDerivedAddress({
  programAddress: PROGRAM_ID,
  seeds: ['lp_position', encoder.encode(config), encoder.encode(lp)],
})

const [policy] = await getProgramDerivedAddress({
  programAddress: PROGRAM_ID,
  seeds: ['policy', encoder.encode(config), bytes(policyId)],
})

const [registry] = await getProgramDerivedAddress({
  programAddress: PROGRAM_ID,
  seeds: ['registry', encoder.encode(config), bytes(epoch)],
})
```

Note that `treasury`, `lp_position`, and `policy` all take the **config** PDA as
a seed, not the mint. Deriving them from the mint directly produces the wrong
address.

## Consequences of the shapes

**One pool per (mint, attester).** `[b"config", usdc_mint, oracle_authority]`
means the pair determines the pool, so no duplicate-pool check is needed — a
second `initialize_pool` for the same pair fails on the `init` constraint. Putting
the attester inside the address is what removes the first-caller race: the pool a
client derives for a known attester cannot be created — or occupied — by anyone
who cannot sign for that attester.

**The treasury is authority-by-PDA.** Because it is an SPL token account whose
authority is the `PoolConfig` PDA, the program moves funds only by reproducing
`[b"config", usdc_mint, oracle_authority, bump]` during a CPI.

**There is no delivery seed.** An attested arrival is not a PDA — it is a signed
message verified during settlement, so it has no address and no owner. The five
literals above are therefore the entire seed surface, and `DELIVERY_SEED` was
removed along with the delivery account.

## Related

- [Accounts & State](/freight_delay/protocol/accounts) — the structs behind these addresses
- [Reference: Instructions & Accounts](/freight_delay/reference/instructions) — which accounts each instruction needs
