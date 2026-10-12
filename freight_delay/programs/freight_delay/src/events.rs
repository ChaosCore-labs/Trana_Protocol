use anchor_lang::prelude::*;

#[event]
pub struct PoolInitialized {
    pub config: Pubkey,
    pub usdc_mint: Pubkey,
    pub treasury: Pubkey,
    pub admin: Pubkey,
    pub oracle_authority: Pubkey,
    pub fee_bps: u16,
}

#[event]
pub struct CapitalDeposited {
    pub config: Pubkey,
    pub lp: Pubkey,
    pub amount: u64,
    pub shares_minted: u64,
    pub total_capital: u64,
}

#[event]
pub struct PolicyPurchased {
    pub config: Pubkey,
    pub policy: Pubkey,
    pub insured: Pubkey,
    pub policy_id: u64,
    pub shipment_id: u64,
    pub expected_delivery: i64,
    pub grace_period: i64,
    pub payout_amount: u64,
    pub premium_amount: u64,
}

/// Emitted by `settle_policy` for every settlement: the attested fact that
/// resolved the policy. No `reporter` field — the evidence is the signature,
/// not a wallet identity.
#[event]
pub struct DeliveryAttested {
    pub config: Pubkey,
    pub policy: Pubkey,
    pub shipment_id: u64,
    pub actual_delivery: i64,
    pub terminal_code: u64,
    pub nonce: u64,
}

#[event]
pub struct PolicySettled {
    pub config: Pubkey,
    pub policy: Pubkey,
    pub insured: Pubkey,
    pub triggered: bool,
    pub payout_amount: u64,
    pub actual_delivery: i64,
    pub expected_delivery: i64,
    pub grace_period: i64,
}

#[event]
pub struct CapitalWithdrawn {
    pub config: Pubkey,
    pub lp: Pubkey,
    pub shares_burned: u64,
    pub amount: u64,
    pub total_capital: u64,
}
