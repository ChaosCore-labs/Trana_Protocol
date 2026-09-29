#![allow(clippy::result_large_err)]

use anchor_lang::{
    AccountDeserialize, AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas,
    solana_program::{instruction::Instruction, system_program},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use freight_delay::{accounts, events, instruction};
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

fn config_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"config", mint.as_ref()], &freight_delay::id()).0
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

fn delivery_pda(shipment_id: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[b"delivery", &shipment_id.to_le_bytes()],
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
    svm.expire_blockhash();
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[payer]).unwrap();
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

    let mut svm = LiteSVM::new();
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

    let config = config_pda(&usdc_mint);
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
            oracle_authority: env.oracle.pubkey(),
        }
        .data(),
        accounts::InitializePool {
            admin: env.admin.pubkey(),
            usdc_mint: env.usdc_mint,
            config: env.config,
            treasury: env.treasury,
            token_program: TOKEN_ID,
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
    let ix = Instruction::new_with_bytes(
        freight_delay::id(),
        &instruction::BuyPolicy {
            policy_id,
            shipment_id: SHIPMENT_ID,
            expected_delivery,
            grace_period: GRACE,
            payout_amount,
            premium_amount,
        }
        .data(),
        accounts::BuyPolicy {
            insured: env.shipper.pubkey(),
            config: env.config,
            usdc_mint: env.usdc_mint,
            treasury: env.treasury,
            insured_usdc: env.shipper_usdc,
            policy: policy_pda(&env.config, policy_id),
            token_program: TOKEN_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut env.svm, &env.shipper, &[ix])
}

fn report_delivery(env: &mut Env, actual_delivery: i64) -> TransactionResult {
    let ix = Instruction::new_with_bytes(
        freight_delay::id(),
        &instruction::ReportDeliveryMilestone {
            shipment_id: SHIPMENT_ID,
            actual_delivery,
            terminal_code: TERMINAL_CODE,
        }
        .data(),
        accounts::ReportDeliveryMilestone {
            reporter: env.oracle.pubkey(),
            config: env.config,
            delivery_report: delivery_pda(SHIPMENT_ID),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut env.svm, &env.oracle, &[ix])
}

fn settle_policy(env: &mut Env, policy_id: u64) -> TransactionResult {
    let crank = Keypair::new();
    env.svm.airdrop(&crank.pubkey(), 100_000_000_000).unwrap();
    let ix = Instruction::new_with_bytes(
        freight_delay::id(),
        &instruction::SettlePolicy {}.data(),
        accounts::SettlePolicy {
            crank: crank.pubkey(),
            config: env.config,
            usdc_mint: env.usdc_mint,
            treasury: env.treasury,
            policy: policy_pda(&env.config, policy_id),
            delivery_report: delivery_pda(SHIPMENT_ID),
            insured_usdc: env.shipper_usdc,
            token_program: TOKEN_ID,
        }
        .to_account_metas(None),
    );
    send(&mut env.svm, &crank, &[ix])
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
    assert_eq!(event.fee_bps, FEE_BPS);
}

#[test]
fn initialize_pool_rejects_fee_above_denominator() {
    let mut env = setup();
    assert!(initialize_pool(&mut env, 10_001).is_err());
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
fn report_delivery_requires_oracle_authority() {
    let mut env = funded_pool(100_000 * UNIT);
    let ix = Instruction::new_with_bytes(
        freight_delay::id(),
        &instruction::ReportDeliveryMilestone {
            shipment_id: SHIPMENT_ID,
            actual_delivery: deadline(),
            terminal_code: TERMINAL_CODE,
        }
        .data(),
        accounts::ReportDeliveryMilestone {
            reporter: env.admin.pubkey(),
            config: env.config,
            delivery_report: delivery_pda(SHIPMENT_ID),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut env.svm, &env.admin, &[ix]).is_err());
    assert!(env.svm.get_account(&delivery_pda(SHIPMENT_ID)).is_none());
}

#[test]
fn report_delivery_writes_attested_milestone() {
    let mut env = funded_pool(100_000 * UNIT);
    let res = report_delivery(&mut env, deadline());
    assert!(res.is_ok());

    let raw = env.svm.get_account(&delivery_pda(SHIPMENT_ID)).unwrap();
    let mut data: &[u8] = &raw.data;
    let report = freight_delay::state::DeliveryReport::try_deserialize(&mut data).unwrap();
    assert_eq!(report.shipment_id, SHIPMENT_ID);
    assert_eq!(report.actual_delivery, deadline());
    assert_eq!(report.terminal_code, TERMINAL_CODE);
    assert_eq!(report.reporter, env.oracle.pubkey());

    let event: events::DeliveryReported = parse_event(&res);
    assert_eq!(event.shipment_id, SHIPMENT_ID);
    assert_eq!(event.actual_delivery, deadline());
    assert_eq!(event.timestamp, BASE_TS);
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
    assert!(report_delivery(&mut env, late).is_ok());

    let shipper_before = balance(&env.svm, &env.shipper_usdc);
    set_ts(&mut env.svm, deadline() + 1);

    let res = settle_policy(&mut env, 1);
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

    let policy = read_policy(&env.svm, &policy_pda(&env.config, 1));
    assert!(policy.is_settled);
    assert!(policy.is_paid);

    let event: events::PolicySettled = parse_event(&res);
    assert!(event.triggered);
    assert_eq!(event.payout_amount, payout);
    assert_eq!(event.actual_delivery, late);
}

#[test]
fn settle_releases_risk_when_within_grace() {
    let capital = 1_000_000 * UNIT;
    let mut env = funded_pool(capital);
    let payout = 500_000 * UNIT;
    let premium = 50_000 * UNIT;
    assert!(buy_policy(&mut env, 1, payout, premium, BASE_TS + SLA_DELTA).is_ok());
    // Arrived exactly at the deadline => still on time, risk released with no payout.
    assert!(report_delivery(&mut env, deadline()).is_ok());

    let shipper_before = balance(&env.svm, &env.shipper_usdc);
    set_ts(&mut env.svm, deadline() + 1);

    let res = settle_policy(&mut env, 1);
    assert!(res.is_ok());

    let fee = premium * FEE_BPS as u64 / 10_000;
    let config = read_config(&env.svm, &env.config);
    assert_eq!(config.total_locked_risk, 0);
    assert_eq!(config.total_capital, capital + premium - fee);
    assert_eq!(balance(&env.svm, &env.shipper_usdc), shipper_before);

    let policy = read_policy(&env.svm, &policy_pda(&env.config, 1));
    assert!(policy.is_settled);
    assert!(!policy.is_paid);

    let event: events::PolicySettled = parse_event(&res);
    assert!(!event.triggered);
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
    assert!(report_delivery(&mut env, deadline() + 100).is_ok());

    set_ts(&mut env.svm, deadline() - 1);
    assert!(settle_policy(&mut env, 1).is_err());
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
    assert!(report_delivery(&mut env, deadline()).is_ok());
    set_ts(&mut env.svm, deadline() + 1);

    assert!(settle_policy(&mut env, 1).is_ok());
    assert!(settle_policy(&mut env, 1).is_err());
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
