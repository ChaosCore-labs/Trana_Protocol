# PDA Seeds & Constants

Every address the program derives comes from five literals in `constants.rs`.
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
pub const DELIVERY_SEED: &[u8] = b"delivery";

/// Basis-point denominator for `PoolConfig::fee_bps` (1 bp = 1/100 of 1%).
#[constant]
pub const FEE_DENOMINATOR: u64 = 10_000;
```

These are declared with `#[constant]` rather than bare `pub const` so they are
emitted into the IDL and visible to clients.

## Derivation table

| Account | Seeds | Notes |
|---|---|---|
| `PoolConfig` | `[b"config", usdc_mint]` | One pool per mint |
| treasury | `[b"treasury", config]` | SPL `TokenAccount`, authority = `PoolConfig` PDA |
| `LpPosition` | `[b"lp_position", config, lp]` | Bound to the LP's key |
| `Policy` | `[b"policy", config, policy_id_le]` | `policy_id` little-endian |
| `DeliveryReport` | `[b"delivery", shipment_id_le]` | **Not** namespaced by config |

The program id is `HKygNZod2WmpPzDVHjcdv7kpd74t68zH9sE4Kp1mxAQP`.

::: danger Seed literals are frozen
Changing any literal, or the byte encoding of a `u64` argument, changes every
derived address and orphans all live accounts. Arguments are positional, so
reordering instruction parameters is equally destructive.
:::

## Integer encoding

`policy_id` and `shipment_id` are `u64` and enter the seeds as little-endian
bytes — the same encoding as `.to_le_bytes()` in Rust and `BigInt64`-style
little-endian writers in clients.

## Client derivation

With `@solana/kit`:

```ts
import { getProgramDerivedAddress, getAddressEncoder, address } from '@solana/kit'

const PROGRAM_ID = address('HKygNZod2WmpPzDVHjcdv7kpd74t68zH9sE4Kp1mxAQP')
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

const [deliveryReport] = await getProgramDerivedAddress({
  programAddress: PROGRAM_ID,
  seeds: ['delivery', bytes(shipmentId)],
})
```

Note that `treasury`, `lp_position`, and `policy` all take the **config** PDA as
a seed, not the mint. Deriving them from the mint directly produces the wrong
address.

## Consequences of the shapes

**One pool per mint.** `[b"config", usdc_mint]` means the mint determines the
pool, so no duplicate-pool check is needed — a second `initialize_pool` for the
same mint fails on the `init` constraint.

**The treasury is authority-by-PDA.** Because it is an SPL token account whose
authority is the `PoolConfig` PDA, the program moves funds only by reproducing
`[b"config", usdc_mint, bump]` during a CPI.

**Delivery reports are global.** Omitting `config` from the delivery seeds makes
a shipment's attested arrival shared infrastructure: the same fact can be read by
many policies, but it is written only once. A shipment that appears in two pools
therefore shares one report.

## Related

- [Accounts & State](/freight_delay/protocol/accounts) — the structs behind these addresses
- [Reference: Instructions & Accounts](/freight_delay/reference/instructions) — which accounts each instruction needs
