use anchor_lang::prelude::*;

#[event]
pub struct PoolInitialized {
    pub config: Pubkey,
    pub usdc_mint: Pubkey,
    pub treasury: Pubkey,
    pub admin: Pubkey,
    pub oracle_authority: Pubkey,
    pub keeper: Pubkey,
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum PolicyOutcome {
    PaidLate,
    ClosedOnTime,
}

/// Terminal event, emitted immediately before the policy PDA is closed. Carries
/// the full terms, so the lifecycle outlives the account that held them.
#[event]
pub struct PolicyClosed {
    pub config: Pubkey,
    pub policy: Pubkey,
    pub shipper: Pubkey,
    pub beneficiary: Pubkey,
    pub shipment_id: u64,
    pub expected_delivery: i64,
    pub grace_period: i64,
    pub payout_amount: u64,
    pub premium: u64,
    pub outcome: PolicyOutcome,
    pub decided_at: i64,
    pub decided_at_slot: u64,
}

#[event]
pub struct CapitalWithdrawn {
    pub config: Pubkey,
    pub lp: Pubkey,
    pub shares_burned: u64,
    pub amount: u64,
    pub total_capital: u64,
}

#[event]
pub struct RootPosted {
    pub config: Pubkey,
    pub epoch: u64,
    pub root: [u8; 32],
    pub count: u64,
}
