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
| `src/terminal49-source.ts` | `Terminal49Source`: the real carrier feed, polled over REST. |

**Scope: the arrival data is simulated.** The project ships `SimulatedSource`
(scripted arrivals, through the identical sign-and-verify path) and nothing else
is wired into the walkthrough or the crank.

For real data, `src/terminal49-source.ts` is a ready adapter behind the same
`ArrivalSource` interface: it polls `GET /v2/containers/{id}/transport_events`,
reads `vessel_arrived` (falling back to `vessel_discharged`) and skips the
`estimated.*` events. It is not part of the pilot, and Terminal49's free tier
cannot run it — reads need a paid plan (only *creating* tracking requests is
permitted; verified against a live key). Bringing the same data on chain through
an oracle is the other documented path; either way the program only sees a signed
payload, so nothing on chain changes.

If you do point it at Terminal49, the key goes in `TERMINAL49_API_KEY` (copy
`.env.example` to `.env` at the repo root; both are handled by `.gitignore`).

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
bun test          # 24 tests
bun run typecheck
bun run attest    # print a signed attestation for one arrival
```

`bun run attest` takes the pool and the attester seed as hex, the shipment and
nonce as decimals, and the attested arrival as unix seconds:

```bash
bun run attest --pool-hex <64 hex chars> --seed-hex <64 hex chars> \
  --shipment 27 --nonce 1 --arrival 1700000000 --terminal 4201 --json
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
