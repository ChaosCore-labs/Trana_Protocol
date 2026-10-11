# attester — off-chain delivery attester

Turns a freight arrival into an **ed25519-signed attestation** that `settle_policy`
verifies on-chain via the ed25519 precompile. This is the "own attester" decided
in CHA-20 and implemented against in CHA-16/CHA-32.

There is no UI and no server yet: this is the library plus its simulated source.

## Why this shape

No public oracle carries freight-delivery data (Pyth/Chainlink are prices;
Switchboard, the only permissionless custom-feed oracle, shut down in Sep 2026).
The oracle primitive we need is *a trusted keypair signing data, verified
on-chain* — so we run the publisher ourselves.

## Layout

| File | Role |
|---|---|
| `src/payload.ts` | The 32-byte signed message: `shipment_id, actual_delivery, terminal_code, nonce` (all LE). **This is the contract with CHA-16.** |
| `src/source.ts` | `ArrivalSource` interface — the program never sees a source. |
| `src/simulated-source.ts` | `SimulatedSource`: scripted arrivals, the **required** demo backup. |
| `src/signing.ts` | ed25519 keypair gen, sign, verify. |
| `src/attest.ts` | Source-agnostic glue: fetch → payload → signature. |

Terminal49Source (the real API) is **not built yet** — it lands behind the same
`ArrivalSource` interface and changes nothing on-chain.

## Payload layout

32 bytes, little-endian, in order:

```
shipment_id     u64
actual_delivery i64   (unix seconds, terminal arrival)
terminal_code   u64
nonce           u64
```

`nonce` binds a signature to one policy so a captured signature cannot settle a
different one. Any change here is a breaking change to the on-chain verify.

## Commands

```bash
bun install
bun test          # 14 tests
bun run typecheck
```

## The simulated source is not a toy

A demo must never be blocked by rate limits, region coverage, an expired trial or
the network. `SimulatedSource` takes a scripted `shipment_id -> arrival` map and
marks every result `simulated: true`. It goes through the identical attest path,
so switching sources is a config change, not a code change.

## Open questions

- `PoolConfig.oracle_authority` is a `Pubkey` fixed at init. The attester's raw
  32-byte ed25519 public key is intended to live there, avoiding an account
  layout change — confirm before CHA-16.
- The attested event is **terminal arrival**, not last-mile delivery (CHA-33).
