# Instructions & Accounts

Every account each instruction requires, with the constraints that bind it.
`mut` marks accounts the handler writes; everything else is read-only for that
instruction.

## `initialize_pool(fee_bps: u16, keeper: Pubkey)`

| Account | Flags | Constraints |
|---|---|---|
| `admin` | `mut`, signer | Pays for both account creations |
| `usdc_mint` | read | `decimals == 6` — every amount is a USDC base unit |
| `oracle_authority` | signer | The attester whose key seeds the config — it must sign |
| `config` | `mut`, **init** | `seeds = [config, usdc_mint, oracle_authority]`, `space = 8 + PoolConfig::INIT_SPACE` |
| `treasury` | **init** | `seeds = [treasury, config]`, `token::mint = usdc_mint`, `token::authority = config` |
| `token_program` | read | SPL Token |
| `system_program` | read | — |

## `deposit_capital(amount: u64)`

| Account | Flags | Constraints |
|---|---|---|
| `lp` | `mut`, signer | — |
| `config` | `mut` | `seeds = [config, config.usdc_mint, config.oracle_authority]`, `bump = config.bump` |
| `usdc_mint` | read | — |
| `treasury` | `mut` | `seeds = [treasury, config]`, `token::mint = usdc_mint`, `token::authority = config` |
| `lp_usdc` | `mut` | `associated_token::mint = usdc_mint`, `associated_token::authority = lp` |
| `lp_position` | `mut`, **init_if_needed** | `seeds = [lp_position, config, lp]`, `payer = lp`, `space = 8 + LpPosition::INIT_SPACE` |
| `token_program` | read | — |
| `system_program` | read | — |

`init_if_needed` is the only use of that constraint in the program, which is why
the `anchor-lang` `init-if-needed` feature is enabled.

## `buy_policy(policy_id, shipment_id, expected_delivery, grace_period, payout_amount, premium_amount)`

| Account | Flags | Constraints |
|---|---|---|
| `insured` | `mut`, signer | The shipper; pays the premium |
| `config` | `mut` | `seeds = [config, config.usdc_mint, config.oracle_authority]`, `bump = config.bump` |
| `usdc_mint` | read | — |
| `treasury` | `mut` | `seeds = [treasury, config]`, `token::mint`, `token::authority = config` |
| `insured_usdc` | `mut` | `associated_token::mint = usdc_mint`, `associated_token::authority = insured` |
| `policy` | **init** | `seeds = [policy, config, policy_id]`, `payer = insured`, `space = 8 + Policy::INIT_SPACE` |
| `token_program` | read | — |
| `system_program` | read | — |

`policy_id` appears in the seeds, so `#[instruction(policy_id: u64)]` is required
on the struct — Anchor cannot derive the address otherwise.



## `settle_policy(attestation: DeliveryAttestation, signature: [u8; 64])`

| Account | Flags | Constraints |
|---|---|---|
| `crank` | `mut`, signer | Any signer; no authority |
| `config` | `mut` | `seeds = [config, config.usdc_mint, config.oracle_authority]`, `bump = config.bump` |
| `usdc_mint` | read | — |
| `treasury` | `mut` | `seeds = [treasury, config]`, `token::mint`, `token::authority = config` |
| `policy` | `mut` | `seeds = [policy, config, policy.policy_id]`, `bump = policy.bump` |
| `insured` | `mut` | The shipper's wallet; `constraint = insured.key() == policy.insured` — receives the closed policy's rent |
| `insured_usdc` | `mut` | `associated_token::mint = usdc_mint`, `associated_token::authority = policy.insured` |
| `instructions` | read | `address = solana_instructions_sysvar::ID` — the instructions sysvar |
| `token_program` | read | — |

The `policy` address is derived from `config` and `policy.policy_id`, so the
caller cannot substitute an unrelated policy. The payout destination is likewise
pinned to `policy.insured` rather than being supplied.

The `instructions` account is the sysvar, not a real program account. The handler
reads it to find the ed25519 precompile instruction that must precede
`settle_policy` in the same transaction, and refuses the call if that instruction
is absent or does not carry exactly the configured `oracle_authority`, the
attestation's 64-byte message (the pool address followed by the delivery fields),
and the supplied signature. This is what makes a
signature valid *for this transaction* rather than merely valid.

No `system_program` — nothing is created.

## `withdraw_capital(shares: u64)`

| Account | Flags | Constraints |
|---|---|---|
| `lp` | `mut`, signer | — |
| `config` | `mut` | `seeds = [config, config.usdc_mint, config.oracle_authority]`, `bump = config.bump` |
| `usdc_mint` | read | — |
| `treasury` | `mut` | `seeds = [treasury, config]`, `token::mint`, `token::authority = config` |
| `lp_usdc` | `mut` | `associated_token::mint = usdc_mint`, `associated_token::authority = lp` |
| `lp_position` | `mut` | `seeds = [lp_position, config, lp]`, `bump = lp_position.bump`, `constraint = lp_position.lp == lp.key() @ Unauthorized` |
| `token_program` | read | — |

No `system_program` — nothing is created.

## `post_root(epoch: u64, root: [u8; 32], count: u64)`

| Account | Flags | Constraints |
|---|---|---|
| `keeper` | `mut`, signer | Pays for the registry creation |
| `config` | read | `seeds = [config, config.usdc_mint, config.oracle_authority]`, `bump = config.bump`, `constraint = keeper.key() == config.keeper` |
| `registry` | **init** | `seeds = [registry, config, epoch]`, `payer = keeper`, `space = 8 + Registry::INIT_SPACE` |
| `system_program` | read | — |

`epoch` appears in the seeds, so `#[instruction(epoch: u64)]` is required on the
struct. The PDA is `init`, not `init_if_needed`, so an epoch is postable exactly
once: a re-post fails rather than overwriting a root that clients may already
have verified against.

## Error mapping

Note that failures from the tables above do **not** produce `FreightDelayError`
variants. A seed mismatch, a bad `bump`, a wrong token authority, or a missing
ATA fails inside Anchor's constraint checks and surfaces as a framework error
such as `ConstraintSeeds`, `ConstraintTokenOwner`, or `AccountNotInitialized`.
Only failures raised by explicit `require!` calls in the handlers map to
[FreightDelayError](/freight_delay/reference/errors). Keep the distinction in mind when
reading logs.

## Related

- [Instructions](/freight_delay/protocol/instructions) — the guards and effects in prose
- [PDA Seeds & Constants](/freight_delay/reference/seeds) — derivation of each address
- [Error Codes](/freight_delay/reference/errors) — the `FreightDelayError` variants
