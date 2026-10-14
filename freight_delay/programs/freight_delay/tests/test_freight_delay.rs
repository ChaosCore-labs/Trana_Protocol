#![allow(clippy::result_large_err)]

use anchor_lang::{
    AccountDeserialize, AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas,
    solana_program::{instruction::Instruction, system_program},
};
use solana_ed25519_program::new_ed25519_instruction_with_signature;
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use freight_delay::{accounts, events, instruction, instructions::QuoteTerms, instructions::shared::DeliveryAttestation};
use litesvm::{LiteSVM, types::TransactionResult};
use litesvm_token::{
    CreateAssociatedTokenAccount, CreateMint, MintToChecked, TOKEN_ID, get_spl_account, spl_token,
};
use solana_awesome::{
    clock::Clock,
    keypair::Keypair,
    message::{Message, VersionedMessage},
    pubkey::Pubkey,
    signer::Signer,
    transaction::versioned::VersionedTransaction,
};

const DECIMALS: u8 = 6;
const FEE_BPS: u16 = 200;
/// One USDC at 6 decimals.
const UNIT: u64 = 1_000_000;
const BASE_TS: i64 = 1_700_000_000;
/// Days of quoted transit after `BASE_TS`.
const SLA_DELTA: i64 = 1_000;
/// Slack allowed past the SLA before a late arrival triggers.
const GRACE: i64 = 200;
const SHIPMENT_ID: u64 = 27;
const TERMINAL_CODE: u64 = 4201;

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    oracle: Keypair,
    lp: Keypair,
    shipper: Keypair,
    usdc_mint: Pubkey,
    config: Pubkey,
    treasury: Pubkey,
    lp_usdc: Pubkey,
    shipper_usdc: Pubkey,
}

fn config_pda(mint: &Pubkey, oracle: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"config", mint.as_ref(), oracle.as_ref()],
        &freight_delay::id(),
    )
    .0
}

fn treasury_pda(config: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"treasury", config.as_ref()], &freight_delay::id()).0
}

fn lp_position_pda(config: &Pubkey, lp: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"lp_position", config.as_ref(), lp.as_ref()],
        &freight_delay::id(),
    )
    .0
}

fn policy_pda(config: &Pubkey, policy_id: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[b"policy", config.as_ref(), &policy_id.to_le_bytes()],
        &freight_delay::id(),
    )
    .0
}

fn quote_pda(config: &Pubkey, quote_id: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[b"quote", config.as_ref(), &quote_id.to_le_bytes()],
        &freight_delay::id(),
    )
    .0
}

fn registry_pda(config: &Pubkey, epoch: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[b"registry", config.as_ref(), &epoch.to_le_bytes()],
        &freight_delay::id(),
    )
    .0
}

/// The SLA deadline the program compares a delivery against.
fn deadline() -> i64 {
    BASE_TS + SLA_DELTA + GRACE
}

fn set_ts(svm: &mut LiteSVM, ts: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = ts;
    svm.set_sysvar(&clock);
}

fn send(svm: &mut LiteSVM, payer: &Keypair, ixs: &[Instruction]) -> TransactionResult {
    send_signed(svm, &[payer], ixs)
}

/// Send with every required signer; `signers[0]` pays the fee.
fn send_signed(svm: &mut LiteSVM, signers: &[&Keypair], ixs: &[Instruction]) -> TransactionResult {
    svm.expire_blockhash();
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    svm.send_transaction(tx)
}

fn parse_event<T>(res: &TransactionResult) -> T
where
    T: AnchorDeserialize + Discriminator,
{
    let logs = &res.as_ref().expect("transaction failed").logs;
    let discriminator: &[u8] = T::DISCRIMINATOR;
    for log in logs {
        if let Some(b64) = log.strip_prefix("Program data: ") {
            let bytes = B64.decode(b64.trim()).expect("valid base64 event");
            if bytes.len() >= 8 && bytes[..8] == *discriminator {
                return T::try_from_slice(&bytes[8..]).expect("event decodes");
            }
        }
    }
    panic!("event not found in logs");
}

fn read_config(svm: &LiteSVM, config: &Pubkey) -> freight_delay::state::PoolConfig {
    let raw = svm.get_account(config).unwrap();
    let mut data: &[u8] = &raw.data;
    freight_delay::state::PoolConfig::try_deserialize(&mut data).unwrap()
}

fn read_policy(svm: &LiteSVM, policy: &Pubkey) -> freight_delay::state::Policy {
    let raw = svm.get_account(policy).unwrap();
    let mut data: &[u8] = &raw.data;
    freight_delay::state::Policy::try_deserialize(&mut data).unwrap()
}

fn balance(svm: &LiteSVM, ata: &Pubkey) -> u64 {
    get_spl_account::<spl_token::state::Account>(svm, ata)
        .unwrap()
        .amount
}

fn setup() -> Env {
    let program_id = freight_delay::id();
    let admin = Keypair::new();
    let oracle = Keypair::new();
    let lp = Keypair::new();
    let shipper = Keypair::new();

    let mut svm = LiteSVM::new().with_precompiles();
    let bytes = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/deploy/freight_delay.so"
    ));
    svm.add_program(program_id, bytes).unwrap();
    for kp in [&admin, &oracle, &lp, &shipper] {
        svm.airdrop(&kp.pubkey(), 100_000_000_000).unwrap();
    }
    set_ts(&mut svm, BASE_TS);

    let usdc_mint = CreateMint::new(&mut svm, &admin)
        .decimals(DECIMALS)
        .send()
        .unwrap();

    let lp_usdc = CreateAssociatedTokenAccount::new(&mut svm, &admin, &usdc_mint)
        .owner(&lp.pubkey())
        .send()
        .unwrap();
    let shipper_usdc = CreateAssociatedTokenAccount::new(&mut svm, &admin, &usdc_mint)
        .owner(&shipper.pubkey())
        .send()
        .unwrap();

    for ata in [&lp_usdc, &shipper_usdc] {
        MintToChecked::new(&mut svm, &admin, &usdc_mint, ata, 10_000_000 * UNIT)
            .decimals(DECIMALS)
            .send()
            .unwrap();
    }

    let config = config_pda(&usdc_mint, &oracle.pubkey());
    let treasury = treasury_pda(&config);

    Env {
        svm,
        admin,
        oracle,
        lp,
        shipper,
        usdc_mint,
        config,
        treasury,
        lp_usdc,
        shipper_usdc,
    }
}

fn initialize_pool(env: &mut Env, fee_bps: u16) -> TransactionResult {
    let ix = Instruction::new_with_bytes(
        freight_delay::id(),
        &instruction::InitializePool {
            fee_bps,
            keeper: env.admin.pubkey(),
            underwriter: env.admin.pubkey(),
        }
        .data(),
        accounts::InitializePool {
            admin: env.admin.pubkey(),
            usdc_mint: env.usdc_mint,
            oracle_authority: env.oracle.pubkey(),
            config: env.config,
            treasury: env.treasury,
            token_program: TOKEN_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    // The attester's key is part of the config's address, so it signs too.
    send_signed(&mut env.svm, &[&env.admin, &env.oracle], &[ix])
}

fn post_root(env: &mut Env, epoch: u64, root: [u8; 32], count: u64) -> TransactionResult {
    let ix = Instruction::new_with_bytes(
        freight_delay::id(),
        &instruction::PostRoot { epoch, root, count }.data(),
        accounts::PostRoot {
            keeper: env.admin.pubkey(),
            config: env.config,
            registry: registry_pda(&env.config, epoch),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut env.svm, &env.admin, &[ix])
}

fn deposit_capital(env: &mut Env, amount: u64) -> TransactionResult {
    let ix = Instruction::new_with_bytes(
        freight_delay::id(),
        &instruction::DepositCapital { amount }.data(),
        accounts::DepositCapital {
            lp: env.lp.pubkey(),
            config: env.config,
            usdc_mint: env.usdc_mint,
            treasury: env.treasury,
            lp_usdc: env.lp_usdc,
            lp_position: lp_position_pda(&env.config, &env.lp.pubkey()),
            token_program: TOKEN_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut env.svm, &env.lp, &[ix])
}

fn buy_policy(
    env: &mut Env,
    policy_id: u64,
    payout_amount: u64,
    premium_amount: u64,
    expected_delivery: i64,
) -> TransactionResult {
    buy_policy_with_grace(env, policy_id, payout_amount, premium_amount, expected_delivery, GRACE)
}

fn author_quote(
    env: &mut Env,
    quote_id: u64,
    payout_amount: u64,
    premium_amount: u64,
    expected_delivery: i64,
    grace_period: i64,
    buyer: Pubkey,
    expires_at: i64,
) -> TransactionResult {
    let ix = Instruction::new_with_bytes(
        freight_delay::id(),
        &instruction::GetQuote {
            terms: QuoteTerms {
                quote_id,
                shipment_id: SHIPMENT_ID,
                expected_delivery,
                grace_period,
                payout_amount,
                premium_amount,
                buyer,
                expires_at,
            },
        }
        .data(),
        accounts::GetQuote {
            underwriter: env.admin.pubkey(),
            config: env.config,
            quote: quote_pda(&env.config, quote_id),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut env.svm, &env.admin, &[ix])
}

fn buy_against_quote(env: &mut Env, policy_id: u64, quote_id: u64) -> TransactionResult {
    let ix = Instruction::new_with_bytes(
        freight_delay::id(),
        &instruction::BuyPolicy {
            policy_id,
            quote_id,
        }
        .data(),
        accounts::BuyPolicy {
            insured: env.shipper.pubkey(),
            config: env.config,
            usdc_mint: env.usdc_mint,
            treasury: env.treasury,
            insured_usdc: env.shipper_usdc,
            quote: quote_pda(&env.config, quote_id),
            policy: policy_pda(&env.config, policy_id),
            token_program: TOKEN_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut env.svm, &env.shipper, &[ix])
}

fn buy_policy_with_grace(
    env: &mut Env,
    policy_id: u64,
    payout_amount: u64,
    premium_amount: u64,
    expected_delivery: i64,
    grace_period: i64,
) -> TransactionResult {
    let quote = author_quote(
        env,
        policy_id,
        payout_amount,
        premium_amount,
        expected_delivery,
        grace_period,
        Pubkey::default(),
        expected_delivery,
    );
    assert!(quote.is_ok(), "the underwriter must be able to author these terms");
    buy_against_quote(env, policy_id, policy_id)
}

/// Sign an arrival with `signer` and build the instruction pair to settle with:
/// the ed25519 precompile, then `settle_policy`. A `signer` other than the pool
/// oracle is how the rejection tests build a valid-looking attestation.
fn signed_attestation(
    env: &Env,
    signer: &Keypair,
    actual_delivery: i64,
    nonce: u64,
) -> (Instruction, Instruction) {
    let att = DeliveryAttestation {
        shipment_id: SHIPMENT_ID,
        actual_delivery,
        terminal_code: TERMINAL_CODE,
        nonce,
    };
    // Built from the program's own encoder, so the test cannot drift from the
    // wire format the contract verifies.
    let message = att.to_message(&env.config);
    let signature: [u8; 64] = signer.sign_message(&message).as_ref().try_into().unwrap();

    // Built by the same crate the runtime uses, so the test cannot encode the
    // header differently from the precompile it is targeting.
    let precompile = new_ed25519_instruction_with_signature(
        &message,
        &signature,
        &signer.pubkey().to_bytes(),
    );

    let settle = Instruction::new_with_bytes(
        freight_delay::id(),
        &instruction::SettlePolicy {
            attestation: att,
            signature,
        }
        .data(),
        accounts::SettlePolicy {
            crank: env.admin.pubkey(),
            config: env.config,
            usdc_mint: env.usdc_mint,
            treasury: env.treasury,
            policy: policy_pda(&env.config, 1),
            insured: env.shipper.pubkey(),
            insured_usdc: env.shipper_usdc,
            instructions: solana_instructions_sysvar::ID,
            token_program: TOKEN_ID,
        }
        .to_account_metas(None),
    );

    (precompile, settle)
}

/// Settle policy `policy_id` against an arrival. The nonce is the policy id, so
/// the signature is bound to that one policy.
fn settle_policy(env: &mut Env, policy_id: u64, actual_delivery: i64) -> TransactionResult {
    let (precompile, settle) = signed_attestation(env, &env.oracle, actual_delivery, policy_id);
    send(&mut env.svm, &env.admin, &[precompile, settle])
}

fn withdraw_capital(env: &mut Env, shares: u64) -> TransactionResult {
    let ix = Instruction::new_with_bytes(
        freight_delay::id(),
        &instruction::WithdrawCapital { shares }.data(),
        accounts::WithdrawCapital {
            lp: env.lp.pubkey(),
            config: env.config,
            usdc_mint: env.usdc_mint,
            treasury: env.treasury,
            lp_usdc: env.lp_usdc,
            lp_position: lp_position_pda(&env.config, &env.lp.pubkey()),
            token_program: TOKEN_ID,
        }
        .to_account_metas(None),
    );
    send(&mut env.svm, &env.lp, &[ix])
}

/// Pool initialised with `capital` USDC of LP liquidity and no policies written.
fn funded_pool(capital: u64) -> Env {
    let mut env = setup();
    assert!(initialize_pool(&mut env, FEE_BPS).is_ok());
    assert!(deposit_capital(&mut env, capital).is_ok());
    env
}

#[test]
fn initialize_pool_sets_state() {
    let mut env = setup();
    let res = initialize_pool(&mut env, FEE_BPS);
    assert!(res.is_ok());

    let config = read_config(&env.svm, &env.config);
    assert_eq!(config.admin, env.admin.pubkey());
    assert_eq!(config.oracle_authority, env.oracle.pubkey());
    assert_eq!(config.keeper, env.admin.pubkey());
    assert_eq!(config.underwriter, env.admin.pubkey());
    assert_eq!(config.usdc_mint, env.usdc_mint);
    assert_eq!(config.treasury, env.treasury);
    assert_eq!(config.fee_bps, FEE_BPS);
    assert_eq!(config.total_capital, 0);
    assert_eq!(config.total_locked_risk, 0);
    assert_eq!(config.total_shares, 0);

    let vault = get_spl_account::<spl_token::state::Account>(&env.svm, &env.treasury).unwrap();
    assert_eq!(vault.amount, 0);
    assert_eq!(vault.mint, env.usdc_mint);
    assert_eq!(vault.owner, env.config);

    let event: events::PoolInitialized = parse_event(&res);
    assert_eq!(event.config, env.config);
    assert_eq!(event.oracle_authority, env.oracle.pubkey());
    assert_eq!(event.keeper, env.admin.pubkey());
    assert_eq!(event.underwriter, env.admin.pubkey());
    assert_eq!(event.fee_bps, FEE_BPS);
}

#[test]
fn initialize_pool_rejects_fee_at_or_above_the_denominator() {
    // A 100% fee is not a fee: it floors `net_premium` to zero, and a pool whose
    // capital can reach zero can never be deposited into again.
    let mut env = setup();
    assert!(initialize_pool(&mut env, 10_001).is_err());
    let mut env = setup();
    assert!(initialize_pool(&mut env, 10_000).is_err());
    let mut env = setup();
    assert!(initialize_pool(&mut env, 9_999).is_ok());
}

#[test]
fn initialize_pool_rejects_an_attester_that_does_not_sign() {
    // The config address includes the attester's key, so a squatter cannot
    // create — and LPs cannot be pointed at — a pool for an attester that has
    // not signed for it.
    let mut env = setup();
    let squatter = Keypair::new();
    env.svm.airdrop(&squatter.pubkey(), 100_000_000_000).unwrap();

    let mut metas = accounts::InitializePool {
        admin: squatter.pubkey(),
        usdc_mint: env.usdc_mint,
        oracle_authority: env.oracle.pubkey(),
        config: env.config,
        treasury: env.treasury,
        token_program: TOKEN_ID,
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    // An attacker cannot produce the attester's signature, so the most it can do
    // is claim the key without signing for it.
    for meta in metas.iter_mut() {
        if meta.pubkey == env.oracle.pubkey() {
            meta.is_signer = false;
        }
    }

    let ix = Instruction::new_with_bytes(
        freight_delay::id(),
        &instruction::InitializePool {
            fee_bps: FEE_BPS,
            keeper: env.admin.pubkey(),
            underwriter: env.admin.pubkey(),
        }
        .data(),
        metas,
    );

    assert!(send(&mut env.svm, &squatter, &[ix]).is_err());
    assert!(env.svm.get_account(&env.config).is_none());
}

#[test]
fn get_quote_rejects_a_deadline_beyond_the_sla_horizon() {
    // No timeout exists, so a deadline the clock cannot reach is unsettleable for good.
    let mut env = funded_pool(1_000_000 * UNIT);
    let horizon = BASE_TS + freight_delay::MAX_SLA_SECONDS;

    // The horizon bounds the deadline, quote plus grace, not the quote alone.
    let last_ok = horizon - GRACE;
    let open = Pubkey::default();
    assert!(
        author_quote(&mut env, 1, 100_000 * UNIT, 1_000 * UNIT, last_ok, GRACE, open, last_ok).is_ok()
    );
    assert!(
        author_quote(&mut env, 2, 100_000 * UNIT, 1_000 * UNIT, last_ok + 1, GRACE, open, last_ok + 1)
            .is_err()
    );
    assert!(
        author_quote(&mut env, 3, 100_000 * UNIT, 1_000 * UNIT, horizon, GRACE, open, horizon).is_err()
    );
    assert!(
        author_quote(&mut env, 4, 100_000 * UNIT, 1_000 * UNIT, i64::MAX, GRACE, open, i64::MAX).is_err()
    );
    // A grace period that on its own reaches past the horizon is refused too.
    assert!(
        author_quote(
            &mut env,
            5,
            100_000 * UNIT,
            1_000 * UNIT,
            BASE_TS + SLA_DELTA,
            i64::MAX,
            open,
            BASE_TS + SLA_DELTA,
        )
        .is_err()
    );

    // The accepted boundary case is buyable, and the rejected ones were never authored.
    assert!(buy_against_quote(&mut env, 1, 1).is_ok());
    assert_eq!(read_config(&env.svm, &env.config).last_policy_id, 1);
}

#[test]
fn buy_policy_rejects_a_policy_id_that_runs_away_from_the_counter() {
    // The counter only moves up, so an unbounded jump would end the id space for
    // every later policy and close the pool to new business for good.
    let mut env = funded_pool(1_000_000 * UNIT);
    let gap = freight_delay::MAX_POLICY_ID_GAP;

    assert!(buy_policy(&mut env, gap, 100_000 * UNIT, 1_000 * UNIT, BASE_TS + SLA_DELTA).is_ok());
    assert!(buy_policy(&mut env, gap * 2 + 1, 100_000 * UNIT, 1_000 * UNIT, BASE_TS + SLA_DELTA)
        .is_err());
    assert!(buy_policy(&mut env, u64::MAX, 100_000 * UNIT, 1_000 * UNIT, BASE_TS + SLA_DELTA)
        .is_err());
    assert_eq!(read_config(&env.svm, &env.config).last_policy_id, gap);
}

#[test]
fn initialize_pool_rejects_a_mint_that_is_not_six_decimals() {
    // Every amount in the program is a USDC base unit: a mint on another scale
    // would make each premium and payout off by orders of magnitude.
    let mut env = setup();
    let odd_mint = CreateMint::new(&mut env.svm, &env.admin).decimals(9).send().unwrap();
    let config = config_pda(&odd_mint, &env.oracle.pubkey());

    let ix = Instruction::new_with_bytes(
        freight_delay::id(),
        &instruction::InitializePool {
            fee_bps: FEE_BPS,
            keeper: env.admin.pubkey(),
            underwriter: env.admin.pubkey(),
        }
        .data(),
        accounts::InitializePool {
            admin: env.admin.pubkey(),
            usdc_mint: odd_mint,
            oracle_authority: env.oracle.pubkey(),
            config,
            treasury: treasury_pda(&config),
            token_program: TOKEN_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );

    assert!(send_signed(&mut env.svm, &[&env.admin, &env.oracle], &[ix]).is_err());
    assert!(env.svm.get_account(&config).is_none());
}

#[test]
fn buy_policy_requires_a_strictly_increasing_policy_id() {
    let mut env = funded_pool(1_000_000 * UNIT);
    assert!(buy_policy(&mut env, 5, 500_000 * UNIT, 50_000 * UNIT, BASE_TS + SLA_DELTA).is_ok());
    // 4's PDA is free, but the id is spent: ids only ever go up.
    assert!(buy_policy(&mut env, 4, 500_000 * UNIT, 50_000 * UNIT, BASE_TS + SLA_DELTA).is_err());
    assert!(buy_policy(&mut env, 5, 500_000 * UNIT, 50_000 * UNIT, BASE_TS + SLA_DELTA).is_err());
    assert!(buy_policy(&mut env, 6, 500_000 * UNIT, 50_000 * UNIT, BASE_TS + SLA_DELTA).is_ok());
    assert_eq!(read_config(&env.svm, &env.config).last_policy_id, 6);
}

#[test]
fn buy_policy_rejects_reusing_a_closed_policy_id() {
    // `nonce` is the policy id and closing the PDA frees the address, so the
    // monotonic guard is what keeps a spent id spent.
    let mut env = funded_pool(1_000_000 * UNIT);
    assert!(buy_policy(&mut env, 1, 500_000 * UNIT, 50_000 * UNIT, BASE_TS + SLA_DELTA).is_ok());

    set_ts(&mut env.svm, deadline() + 1);
    assert!(settle_policy(&mut env, 1, deadline() - 100).is_ok());
    assert!(
        env.svm.get_account(&policy_pda(&env.config, 1)).is_none(),
        "the closed policy's address is free again"
    );

    let later = deadline() + 10_000;
    assert!(
        buy_policy(&mut env, 1, 500_000 * UNIT, 50_000 * UNIT, later).is_err(),
        "a closed id cannot be bought back"
    );
    assert!(buy_policy(&mut env, 2, 500_000 * UNIT, 50_000 * UNIT, later).is_ok());
}

#[test]
fn withdraw_cannot_strand_shares_with_zero_capital() {
    // Redeeming the last free unit while a payout is locked would let the next
    // settlement drive `total_capital` to zero, which both pricing paths divide by.
    let capital = 100 * UNIT;
    let mut env = funded_pool(capital);
    assert!(buy_policy(&mut env, 1, 99 * UNIT, 100 * UNIT, BASE_TS + SLA_DELTA).is_ok());

    // Every unit of the 99 USDC free capital hangs on this one redemption.
    assert!(withdraw_capital(&mut env, 50 * UNIT).is_err());

    // A smaller redemption leaves the pool able to absorb its payout.
    assert!(withdraw_capital(&mut env, 49 * UNIT).is_ok());
    let after = read_config(&env.svm, &env.config);
    assert!(
        after.total_capital > after.total_locked_risk,
        "some capital stays free while shares are outstanding"
    );

    set_ts(&mut env.svm, deadline() + 1);
    assert!(settle_policy(&mut env, 1, deadline() + 100).is_ok());
    let settled = read_config(&env.svm, &env.config);
    assert!(settled.total_capital > 0, "the payout no longer zeroes the pool");

    // And the pool is still usable, which is the whole point.
    assert!(deposit_capital(&mut env, UNIT).is_ok());
}


/// The brick sequence on a zero-fee pool, step for step: deposit, write a payout the
/// free capital exactly covers, redeem that free capital, settle. The redemption is
/// refused now, so the payout cannot zero the pool.
#[test]
fn the_original_brick_sequence_is_refused() {
    let capital = 100 * UNIT;
    let mut env = setup();
    assert!(initialize_pool(&mut env, 0).is_ok());
    assert!(deposit_capital(&mut env, capital).is_ok());
    assert!(buy_policy(&mut env, 1, 100 * UNIT, 100 * UNIT, BASE_TS + SLA_DELTA).is_ok());

    let bought = read_config(&env.svm, &env.config);
    assert_eq!(bought.total_capital, 200 * UNIT);
    assert_eq!(bought.total_locked_risk, 100 * UNIT);
    assert_eq!(bought.total_shares, 100 * UNIT);
    assert_eq!(bought.free_capital(), 100 * UNIT);

    // 50 shares price at exactly the 100 USDC still free: the attack step, refused.
    assert!(withdraw_capital(&mut env, 50 * UNIT).is_err());

    // One unit less leaves capital free, and the pool absorbs its payout.
    assert!(withdraw_capital(&mut env, 49 * UNIT).is_ok());
    set_ts(&mut env.svm, deadline() + 1);
    assert!(settle_policy(&mut env, 1, deadline() + 100).is_ok());

    let settled = read_config(&env.svm, &env.config);
    assert_eq!(settled.total_capital, 2 * UNIT);
    assert_eq!(settled.total_locked_risk, 0);
    assert_eq!(settled.total_shares, 51 * UNIT);

    // The fix's point: both pricing denominators stay non-zero.
    assert!(deposit_capital(&mut env, UNIT).is_ok());
    assert!(withdraw_capital(&mut env, 2 * UNIT).is_ok());
}

#[test]
fn post_root_stores_the_batch_root() {
    let mut env = funded_pool(1_000 * UNIT);
    let root = [7u8; 32];
    let res = post_root(&mut env, 1, root, 42);
    assert!(res.is_ok());

    let raw = env.svm.get_account(&registry_pda(&env.config, 1)).unwrap();
    let mut data: &[u8] = &raw.data;
    let stored = freight_delay::state::Registry::try_deserialize(&mut data).unwrap();
    assert_eq!(stored.epoch, 1);
    assert_eq!(stored.root, root);
    assert_eq!(stored.count, 42);

    let event: events::RootPosted = parse_event(&res);
    assert_eq!(event.config, env.config);
    assert_eq!(event.root, root);
    assert_eq!(event.count, 42);
}

#[test]
fn post_root_rejects_a_stranger() {
    let mut env = funded_pool(1_000 * UNIT);
    let ix = Instruction::new_with_bytes(
        freight_delay::id(),
        &instruction::PostRoot {
            epoch: 1,
            root: [7u8; 32],
            count: 1,
        }
        .data(),
        accounts::PostRoot {
            keeper: env.lp.pubkey(),
            config: env.config,
            registry: registry_pda(&env.config, 1),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    // `env.lp` is not the configured keeper.
    assert!(send(&mut env.svm, &env.lp, &[ix]).is_err());
    assert!(env.svm.get_account(&registry_pda(&env.config, 1)).is_none());
}

#[test]
fn deposit_capital_mints_shares_one_to_one() {
    let mut env = setup();
    assert!(initialize_pool(&mut env, FEE_BPS).is_ok());

    let amount = 1_000_000 * UNIT;
    let res = deposit_capital(&mut env, amount);
    assert!(res.is_ok());

    let config = read_config(&env.svm, &env.config);
    assert_eq!(config.total_capital, amount);
    assert_eq!(config.total_shares, amount);
    assert_eq!(balance(&env.svm, &env.treasury), amount);

    let position = lp_position_pda(&env.config, &env.lp.pubkey());
    let raw = env.svm.get_account(&position).unwrap();
    let mut data: &[u8] = &raw.data;
    let position = freight_delay::state::LpPosition::try_deserialize(&mut data).unwrap();
    assert_eq!(position.lp, env.lp.pubkey());
    assert_eq!(position.shares, amount);

    let event: events::CapitalDeposited = parse_event(&res);
    assert_eq!(event.amount, amount);
    assert_eq!(event.shares_minted, amount);
    assert_eq!(event.total_capital, amount);
}

#[test]
fn deposit_capital_rejects_zero() {
    let mut env = setup();
    assert!(initialize_pool(&mut env, FEE_BPS).is_ok());
    assert!(deposit_capital(&mut env, 0).is_err());
}

#[test]
fn buy_policy_locks_risk_and_collects_net_premium() {
    let capital = 1_000_000 * UNIT;
    let mut env = funded_pool(capital);

    let payout = 500_000 * UNIT;
    let premium = 50_000 * UNIT;
    let expected = BASE_TS + SLA_DELTA;
    let res = buy_policy(&mut env, 1, payout, premium, expected);
    assert!(res.is_ok());

    let fee = premium * FEE_BPS as u64 / 10_000;
    let config = read_config(&env.svm, &env.config);
    assert_eq!(config.total_locked_risk, payout);
    assert_eq!(config.total_capital, capital + premium - fee);
    assert_eq!(config.total_fees, fee);

    // Vault holds LP capital plus the full premium.
    assert_eq!(balance(&env.svm, &env.treasury), capital + premium);

    let policy = read_policy(&env.svm, &policy_pda(&env.config, 1));
    assert_eq!(policy.insured, env.shipper.pubkey());
    assert_eq!(policy.shipment_id, SHIPMENT_ID);
    assert_eq!(policy.expected_delivery, expected);
    assert_eq!(policy.grace_period, GRACE);
    assert_eq!(policy.payout_amount, payout);
    assert!(!policy.is_settled);
    assert!(!policy.is_paid);

    let event: events::PolicyPurchased = parse_event(&res);
    assert_eq!(event.policy_id, 1);
    assert_eq!(event.shipment_id, SHIPMENT_ID);
    assert_eq!(event.payout_amount, payout);
    assert_eq!(event.expected_delivery, expected);
}

#[test]
fn buy_policy_rejects_payout_above_free_capital() {
    let mut env = funded_pool(100_000 * UNIT);
    // Pool only has 100k USDC free; a 500k payout cannot be collateralised.
    let res = buy_policy(
        &mut env,
        1,
        500_000 * UNIT,
        5_000 * UNIT,
        BASE_TS + SLA_DELTA,
    );
    assert!(res.is_err());
}

#[test]
fn get_quote_rejects_an_unrepresentable_deadline() {
    // The deadline is recomputed at settlement, so a sum that overflows would
    // make the policy unsettleable and lock its collateral for good.
    let mut env = funded_pool(100_000 * UNIT);
    let res = author_quote(
        &mut env,
        1,
        UNIT,
        UNIT,
        i64::MAX,
        GRACE,
        Pubkey::default(),
        BASE_TS + 1,
    );
    assert!(res.is_err());
    assert!(env.svm.get_account(&quote_pda(&env.config, 1)).is_none());
}

#[test]
fn settle_emits_the_attested_delivery() {
    // The on-chain record of what the oracle attested.
    let mut env = funded_pool(1_000_000 * UNIT);
    assert!(
        buy_policy(&mut env, 1, 500_000 * UNIT, 50_000 * UNIT, BASE_TS + SLA_DELTA).is_ok()
    );
    set_ts(&mut env.svm, deadline() + 1);

    let late = deadline() + 100;
    let res = settle_policy(&mut env, 1, late);
    assert!(res.is_ok());

    let event: events::DeliveryAttested = parse_event(&res);
    assert_eq!(event.config, env.config);
    assert_eq!(event.policy, policy_pda(&env.config, 1));
    assert_eq!(event.shipment_id, SHIPMENT_ID);
    assert_eq!(event.actual_delivery, late);
    assert_eq!(event.terminal_code, TERMINAL_CODE);
    assert_eq!(event.nonce, 1);
}

#[test]
fn settle_pays_shipper_on_late_delivery() {
    let capital = 1_000_000 * UNIT;
    let mut env = funded_pool(capital);
    let payout = 500_000 * UNIT;
    let premium = 50_000 * UNIT;
    assert!(buy_policy(&mut env, 1, payout, premium, BASE_TS + SLA_DELTA).is_ok());
    // Delivered 100s past the SLA plus grace => the policy pays out.
    let late = deadline() + 100;

    let shipper_before = balance(&env.svm, &env.shipper_usdc);
    let shipper_sol_before = env.svm.get_account(&env.shipper.pubkey()).unwrap().lamports;
    set_ts(&mut env.svm, deadline() + 1);

    let res = settle_policy(&mut env, 1, late);
    assert!(res.is_ok());

    let fee = premium * FEE_BPS as u64 / 10_000;
    let config = read_config(&env.svm, &env.config);
    assert_eq!(config.total_locked_risk, 0);
    assert_eq!(config.total_capital, capital + premium - fee - payout);
    // Vault = capital + net premium + fee - payout = total_capital + total_fees.
    assert_eq!(
        balance(&env.svm, &env.treasury),
        config.total_capital + config.total_fees
    );
    assert_eq!(
        balance(&env.svm, &env.shipper_usdc),
        shipper_before + payout
    );

    // The policy PDA is closed on settlement; `PolicyClosed` is the record and
    // the rent comes home to the shipper.
    assert!(
        env.svm.get_account(&policy_pda(&env.config, 1)).is_none(),
        "a settled policy is closed"
    );
    assert!(
        env.svm.get_account(&env.shipper.pubkey()).unwrap().lamports > shipper_sol_before,
        "the policy rent returns to the shipper"
    );

    let event: events::PolicySettled = parse_event(&res);
    assert!(event.triggered);
    assert_eq!(event.payout_amount, payout);
    assert_eq!(event.actual_delivery, late);

    let closed: events::PolicyClosed = parse_event(&res);
    assert_eq!(closed.policy, policy_pda(&env.config, 1));
    assert_eq!(closed.shipper, env.shipper.pubkey());
    assert_eq!(closed.outcome, events::PolicyOutcome::PaidLate);
    assert_eq!(closed.payout_amount, payout);
    assert_eq!(closed.premium, premium);
}

#[test]
fn settle_releases_risk_when_within_grace() {
    let capital = 1_000_000 * UNIT;
    let mut env = funded_pool(capital);
    let payout = 500_000 * UNIT;
    let premium = 50_000 * UNIT;
    assert!(buy_policy(&mut env, 1, payout, premium, BASE_TS + SLA_DELTA).is_ok());
    // Arrived exactly at the deadline => still on time, risk released with no payout.
    let on_time = deadline();

    let shipper_before = balance(&env.svm, &env.shipper_usdc);
    set_ts(&mut env.svm, deadline() + 1);

    let res = settle_policy(&mut env, 1, on_time);
    assert!(res.is_ok());

    let fee = premium * FEE_BPS as u64 / 10_000;
    let config = read_config(&env.svm, &env.config);
    assert_eq!(config.total_locked_risk, 0);
    assert_eq!(config.total_capital, capital + premium - fee);
    assert_eq!(balance(&env.svm, &env.shipper_usdc), shipper_before);

    assert!(
        env.svm.get_account(&policy_pda(&env.config, 1)).is_none(),
        "an on-time settle closes the policy too"
    );

    let event: events::PolicySettled = parse_event(&res);
    assert!(!event.triggered);

    let closed: events::PolicyClosed = parse_event(&res);
    assert_eq!(closed.outcome, events::PolicyOutcome::ClosedOnTime);
}

#[test]
fn settle_rejects_before_maturity() {
    let mut env = funded_pool(1_000_000 * UNIT);
    assert!(
        buy_policy(
            &mut env,
            1,
            500_000 * UNIT,
            50_000 * UNIT,
            BASE_TS + SLA_DELTA
        )
        .is_ok()
    );

    set_ts(&mut env.svm, deadline() - 1);
    assert!(settle_policy(&mut env, 1, deadline() + 100).is_err());
}

#[test]
fn settle_rejects_double_settlement() {
    let mut env = funded_pool(1_000_000 * UNIT);
    assert!(
        buy_policy(
            &mut env,
            1,
            500_000 * UNIT,
            50_000 * UNIT,
            BASE_TS + SLA_DELTA
        )
        .is_ok()
    );
    set_ts(&mut env.svm, deadline() + 1);

    assert!(settle_policy(&mut env, 1, deadline()).is_ok());
    assert!(settle_policy(&mut env, 1, deadline()).is_err());
}

#[test]
fn withdraw_capital_returns_usdc_and_burns_shares() {
    let capital = 1_000_000 * UNIT;
    let mut env = funded_pool(capital);

    let lp_before = balance(&env.svm, &env.lp_usdc);
    let shares = 400_000 * UNIT;
    let res = withdraw_capital(&mut env, shares);
    assert!(res.is_ok());

    let config = read_config(&env.svm, &env.config);
    assert_eq!(config.total_shares, capital - shares);
    assert_eq!(config.total_capital, capital - shares);
    assert_eq!(balance(&env.svm, &env.lp_usdc), lp_before + shares);
    assert_eq!(balance(&env.svm, &env.treasury), capital - shares);

    let event: events::CapitalWithdrawn = parse_event(&res);
    assert_eq!(event.shares_burned, shares);
    assert_eq!(event.amount, shares);
}

#[test]
fn withdraw_capital_closes_a_position_that_reaches_zero_shares() {
    // A position is only worth its rent while it has shares: redeeming the last
    // one closes the account and returns the rent to the LP (CHA-18).
    let capital = 1_000_000 * UNIT;
    let mut env = funded_pool(capital);
    let position = lp_position_pda(&env.config, &env.lp.pubkey());

    // A partial withdrawal leaves the position open.
    assert!(withdraw_capital(&mut env, 400_000 * UNIT).is_ok());
    assert!(
        env.svm.get_account(&position).is_some(),
        "a position with shares left must stay open"
    );

    // Burning the last share closes it. The rent (over a million lamports for 49
    // bytes) dwarfs the 5000-lamport fee, so the LP's balance still rises.
    let lp_before = env.svm.get_account(&env.lp.pubkey()).unwrap().lamports;
    assert!(withdraw_capital(&mut env, 600_000 * UNIT).is_ok());
    assert!(
        env.svm.get_account(&position).is_none(),
        "a zero-share position must be closed"
    );
    assert!(env.svm.get_account(&env.lp.pubkey()).unwrap().lamports > lp_before);

    // The same LP can deposit again: `init_if_needed` recreates the account.
    assert!(deposit_capital(&mut env, 100_000 * UNIT).is_ok());
    assert!(env.svm.get_account(&position).is_some());
}

#[test]
fn withdraw_rejects_amount_above_free_capital() {
    let capital = 1_000_000 * UNIT;
    let mut env = funded_pool(capital);
    // Lock 500k of the 1M pool, leaving only 549k free.
    assert!(
        buy_policy(
            &mut env,
            1,
            500_000 * UNIT,
            50_000 * UNIT,
            BASE_TS + SLA_DELTA
        )
        .is_ok()
    );

    // Redeeming all shares would need ~1.049M USDC, far above free capital.
    assert!(withdraw_capital(&mut env, capital).is_err());
}

#[test]
fn withdraw_rejects_unknown_position() {
    let mut env = funded_pool(1_000_000 * UNIT);
    assert!(withdraw_capital(&mut env, 1).is_ok());

    // A second LP with no position cannot redeem against the pool.
    let stranger = Keypair::new();
    env.svm
        .airdrop(&stranger.pubkey(), 100_000_000_000)
        .unwrap();
    let stranger_usdc = CreateAssociatedTokenAccount::new(&mut env.svm, &env.admin, &env.usdc_mint)
        .owner(&stranger.pubkey())
        .send()
        .unwrap();
    MintToChecked::new(
        &mut env.svm,
        &env.admin,
        &env.usdc_mint,
        &stranger_usdc,
        100 * UNIT,
    )
    .decimals(DECIMALS)
    .send()
    .unwrap();

    let ix = Instruction::new_with_bytes(
        freight_delay::id(),
        &instruction::WithdrawCapital { shares: 1 }.data(),
        accounts::WithdrawCapital {
            lp: stranger.pubkey(),
            config: env.config,
            usdc_mint: env.usdc_mint,
            treasury: env.treasury,
            lp_usdc: stranger_usdc,
            lp_position: lp_position_pda(&env.config, &stranger.pubkey()),
            token_program: TOKEN_ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut env.svm, &stranger, &[ix]).is_err());
}

#[test]
fn settle_rejects_an_attestation_signed_by_a_stranger() {
    // Only the oracle's key makes an attestation authoritative: the same bytes from
    // another key must not move money.
    let mut env = funded_pool(1_000_000 * UNIT);
    assert!(
        buy_policy(&mut env, 1, 500_000 * UNIT, 50_000 * UNIT, BASE_TS + SLA_DELTA).is_ok()
    );
    set_ts(&mut env.svm, deadline() + 1);

    // Correctly shaped and nonced, signed by a key that is not the oracle.
    let impostor = Keypair::new();
    let (precompile, settle) = signed_attestation(&env, &impostor, deadline() + 100, 1);

    assert!(send(&mut env.svm, &env.admin, &[precompile, settle]).is_err());
    assert!(!read_policy(&env.svm, &policy_pda(&env.config, 1)).is_settled);
}

#[test]
fn settle_rejects_an_attestation_with_the_wrong_nonce() {
    // A signature is bound to one policy by its nonce. Reusing policy 1's
    // signature shape under a different nonce must not settle policy 1.
    let mut env = funded_pool(1_000_000 * UNIT);
    assert!(
        buy_policy(&mut env, 1, 500_000 * UNIT, 50_000 * UNIT, BASE_TS + SLA_DELTA).is_ok()
    );
    set_ts(&mut env.svm, deadline() + 1);

    // Correct key, correct payload, but nonce 999 instead of the policy id 1.
    let (precompile, settle) = signed_attestation(&env, &env.oracle, deadline() + 100, 999);
    assert!(send(&mut env.svm, &env.admin, &[precompile, settle]).is_err());
    assert!(!read_policy(&env.svm, &policy_pda(&env.config, 1)).is_settled);
}

/// Decode a lowercase hex string into a fixed-size array.
fn from_hex<const N: usize>(hex: &str) -> [u8; N] {
    assert_eq!(hex.len(), N * 2, "hex length mismatch");
    let mut out = [0u8; N];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).expect("valid hex");
    }
    out
}

/// The attestation below is produced by `attester/` (TypeScript), not by this
/// test. Regenerate with `bun run scripts/attestation-vector.ts` there.
const ATTESTER_POOL_HEX: &str =
    "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b";
const ATTESTER_PUBKEY_HEX: &str =
    "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c";
const ATTESTER_MSG_HEX: &str = concat!(
    "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b",
    "1b0000000000000014f653650000000069100000000000000100000000000000",
);
const ATTESTER_SIG_HEX: &str = concat!(
    "6cf94cc06d67229a1233e585781f314a2a7a5456e33e4959727fc5844e8d951e",
    "f5fd1673c54c38de3117164a55a4e0f998d261765d838da56c766341a6639406",
);

#[test]
fn to_message_matches_the_typescript_attester() {
    // The cross-language contract: this message comes from `attester/`
    // (TypeScript), so a layout drift on either side stops the comparison. Two
    // suites each checking their own encoder against their own decoder cannot
    // catch that.
    let att = DeliveryAttestation {
        shipment_id: SHIPMENT_ID,
        actual_delivery: deadline() + 100,
        terminal_code: TERMINAL_CODE,
        nonce: 1,
    };
    let pool = Pubkey::new_from_array(from_hex::<32>(ATTESTER_POOL_HEX));
    assert_eq!(
        att.to_message(&pool),
        from_hex::<64>(ATTESTER_MSG_HEX),
        "Rust encoder disagrees with the attester vector"
    );
}

#[test]
fn the_typescript_attester_signature_verifies_through_the_precompile() {
    // The other half of the contract: the attester's own signature over that
    // message, checked by the precompile `settle_policy` scans. A static vector
    // cannot describe a live pool, because the pool is part of the signed bytes
    // and every test pool is derived from fresh keypairs — so the settlement
    // path itself is covered by the tests that sign against `env.config`.
    let mut env = setup();
    let message: [u8; 64] = from_hex(ATTESTER_MSG_HEX);
    let pubkey: [u8; 32] = from_hex(ATTESTER_PUBKEY_HEX);
    let signature: [u8; 64] = from_hex(ATTESTER_SIG_HEX);

    let precompile = new_ed25519_instruction_with_signature(&message, &signature, &pubkey);
    assert!(
        send(&mut env.svm, &env.admin, &[precompile]).is_ok(),
        "the attester's signature must verify"
    );
}

#[test]
fn settle_releases_locked_risk_without_any_timeout_path() {
    // Every policy is settleable once its deadline passes: the clock only moves
    // forward, so the maturity gate is satisfied for good. A late crank with an
    // on-time arrival releases the risk without paying.
    let mut env = funded_pool(1_000_000 * UNIT);
    assert!(
        buy_policy(&mut env, 1, 500_000 * UNIT, 50_000 * UNIT, BASE_TS + SLA_DELTA).is_ok()
    );

    // Long past the deadline that a real policy would have been settled by.
    set_ts(&mut env.svm, deadline() + 400 * 24 * 60 * 60);

    let before = read_config(&env.svm, &env.config);
    assert_eq!(before.total_locked_risk, 500_000 * UNIT);

    // An on-time arrival, attested long after the fact, still settles.
    assert!(
        settle_policy(&mut env, 1, deadline() - 100).is_ok(),
        "a matured policy must be settleable with any attested arrival"
    );

    let after = read_config(&env.svm, &env.config);
    assert!(
        env.svm.get_account(&policy_pda(&env.config, 1)).is_none(),
        "the settled policy is closed"
    );
    assert_eq!(
        after.total_locked_risk,
        before.total_locked_risk - 500_000 * UNIT,
        "the payout is no longer locked"
    );
    assert_eq!(
        after.total_capital, before.total_capital,
        "an untriggered settle returns capital to free capacity"
    );
    assert_eq!(
        after.free_capital(),
        after.total_capital,
        "nothing is left locked once settled"
    );
}

#[test]
fn get_quote_requires_the_underwriter() {
    // A quote is the only place a price enters the protocol, so minting one must
    // be the underwriter's alone.
    let mut env = funded_pool(100_000 * UNIT);
    let expected = BASE_TS + SLA_DELTA;
    let ix = Instruction::new_with_bytes(
        freight_delay::id(),
        &instruction::GetQuote {
            terms: QuoteTerms {
                quote_id: 1,
                shipment_id: SHIPMENT_ID,
                expected_delivery: expected,
                grace_period: GRACE,
                payout_amount: 10_000 * UNIT,
                premium_amount: 1_000 * UNIT,
                buyer: Pubkey::default(),
                expires_at: expected,
            },
        }
        .data(),
        accounts::GetQuote {
            underwriter: env.lp.pubkey(),
            config: env.config,
            quote: quote_pda(&env.config, 1),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut env.svm, &env.lp, &[ix]).is_err());
    assert!(env.svm.get_account(&quote_pda(&env.config, 1)).is_none());
}

#[test]
fn get_quote_rejects_an_expiry_that_outlives_the_expected_arrival() {
    // Terms that could still be accepted after the ship was due invite the buyer
    // who already knows it is late.
    let mut env = funded_pool(100_000 * UNIT);
    let expected = BASE_TS + SLA_DELTA;
    let open = Pubkey::default();

    assert!(
        author_quote(&mut env, 1, 10_000 * UNIT, 1_000 * UNIT, expected, GRACE, open, expected + 1)
            .is_err()
    );
    assert!(
        author_quote(&mut env, 2, 10_000 * UNIT, 1_000 * UNIT, expected, GRACE, open, BASE_TS)
            .is_err(),
        "an expiry at the current second is not in the future"
    );
    assert!(
        author_quote(&mut env, 3, 10_000 * UNIT, 1_000 * UNIT, expected, GRACE, open, expected)
            .is_ok()
    );
}

#[test]
fn get_quote_rejects_zero_amounts() {
    let mut env = funded_pool(100_000 * UNIT);
    let expected = BASE_TS + SLA_DELTA;
    let open = Pubkey::default();
    assert!(author_quote(&mut env, 1, 0, 1_000 * UNIT, expected, GRACE, open, expected).is_err());
    assert!(author_quote(&mut env, 2, 10_000 * UNIT, 0, expected, GRACE, open, expected).is_err());
}

#[test]
fn buy_policy_takes_every_term_from_the_quote() {
    // The regression: the buyer names no terms at all, so it cannot name a token
    // premium for a large payout. What the underwriter authored is what is sold.
    let mut env = funded_pool(1_000_000 * UNIT);
    let payout = 900_000 * UNIT;
    let premium = 1 * UNIT;
    let expected = BASE_TS + SLA_DELTA;
    assert!(
        author_quote(&mut env, 7, payout, premium, expected, GRACE, Pubkey::default(), expected)
            .is_ok()
    );

    let shipper_before = balance(&env.svm, &env.shipper_usdc);
    let res = buy_against_quote(&mut env, 1, 7);
    assert!(res.is_ok());

    let policy = read_policy(&env.svm, &policy_pda(&env.config, 1));
    assert_eq!(policy.payout_amount, payout);
    assert_eq!(policy.premium_amount, premium);
    assert_eq!(policy.expected_delivery, expected);
    assert_eq!(policy.grace_period, GRACE);
    assert_eq!(policy.shipment_id, SHIPMENT_ID);

    let config = read_config(&env.svm, &env.config);
    assert_eq!(config.total_locked_risk, payout);
    assert_eq!(balance(&env.svm, &env.shipper_usdc), shipper_before - premium);

    let event: events::PolicyPurchased = parse_event(&res);
    assert_eq!(event.quote, quote_pda(&env.config, 7));
    assert_eq!(event.quote_id, 7);
    assert_eq!(event.payout_amount, payout);
    assert_eq!(event.premium_amount, premium);
}

#[test]
fn buy_policy_closes_the_quote_so_it_backs_one_policy() {
    let mut env = funded_pool(1_000_000 * UNIT);
    let expected = BASE_TS + SLA_DELTA;
    assert!(
        author_quote(&mut env, 3, 100_000 * UNIT, 10_000 * UNIT, expected, GRACE, Pubkey::default(), expected)
            .is_ok()
    );
    assert!(buy_against_quote(&mut env, 1, 3).is_ok());

    assert!(
        env.svm.get_account(&quote_pda(&env.config, 3)).is_none(),
        "the accepted quote is closed"
    );
    assert!(
        buy_against_quote(&mut env, 2, 3).is_err(),
        "a spent quote cannot back a second policy"
    );
    assert!(env.svm.get_account(&policy_pda(&env.config, 2)).is_none());
}

#[test]
fn buy_policy_refuses_a_quote_reserved_for_another_buyer() {
    let mut env = funded_pool(1_000_000 * UNIT);
    let expected = BASE_TS + SLA_DELTA;
    let reserved_for = env.lp.pubkey();
    assert!(
        author_quote(&mut env, 1, 100_000 * UNIT, 10_000 * UNIT, expected, GRACE, reserved_for, expected)
            .is_ok()
    );

    assert!(buy_against_quote(&mut env, 1, 1).is_err());
    assert_eq!(read_config(&env.svm, &env.config).last_policy_id, 0);
    assert!(env.svm.get_account(&quote_pda(&env.config, 1)).is_some());
}

#[test]
fn buy_policy_refuses_an_expired_quote() {
    let mut env = funded_pool(1_000_000 * UNIT);
    let expected = BASE_TS + SLA_DELTA;
    let expires = BASE_TS + 100;
    assert!(
        author_quote(&mut env, 1, 100_000 * UNIT, 10_000 * UNIT, expected, GRACE, Pubkey::default(), expires)
            .is_ok()
    );

    set_ts(&mut env.svm, expires + 1);
    assert!(buy_against_quote(&mut env, 1, 1).is_err());
    assert!(env.svm.get_account(&policy_pda(&env.config, 1)).is_none());
    assert_eq!(read_config(&env.svm, &env.config).last_policy_id, 0);
}
