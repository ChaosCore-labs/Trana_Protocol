# Instructions & Accounts

Every account each instruction requires, with the constraints that bind it.
`mut` marks accounts the handler writes; everything else is read-only for that
instruction.

## `initialize_pool(fee_bps: u16, oracle_authority: Pubkey)`

| Account | Flags | Constraints |
|---|---|---|
| `admin` | `mut`, signer | Pays for both account creations |
| `usdc_mint` | read | — |
| `config` | `mut`, **init** | `seeds = [config, usdc_mint]`, `space = 8 + PoolConfig::INIT_SPACE` |
| `treasury` | **init** | `seeds = [treasury, config]`, `token::mint = usdc_mint`, `token::authority = config` |
| `token_program` | read | SPL Token |
| `system_program` | read | — |

## `deposit_capital(amount: u64)`

| Account | Flags | Constraints |
|---|---|---|
| `lp` | `mut`, signer | — |
| `config` | `mut` | `seeds = [config, config.usdc_mint]`, `bump = config.bump` |
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
| `config` | `mut` | `seeds = [config, config.usdc_mint]`, `bump = config.bump` |
| `usdc_mint` | read | — |
| `treasury` | `mut` | `seeds = [treasury, config]`, `token::mint`, `token::authority = config` |
| `insured_usdc` | `mut` | `associated_token::mint = usdc_mint`, `associated_token::authority = insured` |
| `policy` | **init** | `seeds = [policy, config, policy_id]`, `payer = insured`, `space = 8 + Policy::INIT_SPACE` |
| `token_program` | read | — |
| `system_program` | read | — |

`policy_id` appears in the seeds, so `#[instruction(policy_id: u64)]` is required
on the struct — Anchor cannot derive the address otherwise.

## `report_delivery_milestone(shipment_id: u64, actual_delivery: i64, terminal_code: u64)`

| Account | Flags | Constraints |
|---|---|---|
| `reporter` | `mut`, signer | Must equal `config.oracle_authority`, checked in the handler |
| `config` | read | `seeds = [config, config.usdc_mint]`, `bump = config.bump` |
| `delivery_report` | **init** | `seeds = [delivery, shipment_id]`, `payer = reporter`, `space = 8 + DeliveryReport::INIT_SPACE` |
| `system_program` | read | — |

`config` is not `mut` here — the handler performs no pool mutation, so it needs
no write lock. The account is read only to check the reporter against
`oracle_authority`.

## `settle_policy()`

| Account | Flags | Constraints |
|---|---|---|
| `crank` | `mut`, signer | Any signer; no authority |
| `config` | `mut` | `seeds = [config, config.usdc_mint]`, `bump = config.bump` |
| `usdc_mint` | read | — |
| `treasury` | `mut` | `seeds = [treasury, config]`, `token::mint`, `token::authority = config` |
| `policy` | `mut` | `seeds = [policy, config, policy.policy_id]`, `bump = policy.bump` |
| `delivery_report` | read | `seeds = [delivery, policy.shipment_id]`, `bump = delivery_report.bump` |
| `insured_usdc` | `mut` | `associated_token::mint = usdc_mint`, `associated_token::authority = policy.insured` |
| `token_program` | read | — |

This is the clearest illustration of why PDAs matter: the `policy` and
`delivery_report` addresses are derived from *other accounts' fields*
(`policy.policy_id`, `policy.shipment_id`), so the caller cannot substitute
unrelated accounts. The payout destination is likewise pinned to `policy.insured`
rather than being supplied.

No `system_program` — nothing is created.

## `withdraw_capital(shares: u64)`

| Account | Flags | Constraints |
|---|---|---|
| `lp` | `mut`, signer | — |
| `config` | `mut` | `seeds = [config, config.usdc_mint]`, `bump = config.bump` |
| `usdc_mint` | read | — |
| `treasury` | `mut` | `seeds = [treasury, config]`, `token::mint`, `token::authority = config` |
| `lp_usdc` | `mut` | `associated_token::mint = usdc_mint`, `associated_token::authority = lp` |
| `lp_position` | `mut` | `seeds = [lp_position, config, lp]`, `bump = lp_position.bump`, `constraint = lp_position.lp == lp.key() @ Unauthorized` |
| `token_program` | read | — |

No `system_program` — nothing is created.

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
