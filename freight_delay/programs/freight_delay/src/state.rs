use anchor_lang::prelude::*;

use crate::error::FreightDelayError;

#[account]
#[derive(InitSpace)]
pub struct PoolConfig {
    pub admin: Pubkey,
    /// Raw 32-byte ed25519 key, not a wallet address.
    pub oracle_authority: Pubkey,
    pub keeper: Pubkey,
    pub usdc_mint: Pubkey,
    pub treasury: Pubkey,
    /// Deposits plus net premiums, minus realised payouts.
    pub total_capital: u64,
    /// Sum of `payout_amount` over unsettled policies.
    pub total_locked_risk: u64,
    pub total_shares: u64,
    pub total_fees: u64,
    /// Strictly increasing and never reused, even after a policy's PDA closes:
    /// `nonce` is the policy id, so a repeat would let a stale attestation settle
    /// a policy it was not signed for.
    pub last_policy_id: u64,
    pub fee_bps: u16,
    pub bump: u8,
}

impl PoolConfig {
    pub fn free_capital(&self) -> u64 {
        self.total_capital.saturating_sub(self.total_locked_risk)
    }

    /// Full-collateralisation invariant, checked by every handler that moves capital.
    pub fn assert_solvent(&self) -> Result<()> {
        require!(
            self.total_locked_risk <= self.total_capital,
            FreightDelayError::Insolvent
        );
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct LpPosition {
    pub lp: Pubkey,
    pub shares: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Policy {
    pub insured: Pubkey,
    pub policy_id: u64,
    pub shipment_id: u64,
    /// The destination-terminal arrival the SLA is measured against.
    pub expected_delivery: i64,
    /// Unbounded on chain: a grace period near the corridor's transit time sells a
    /// policy that can practically never trigger and ties up its collateral.
    pub grace_period: i64,
    pub payout_amount: u64,
    pub premium_amount: u64,
    pub is_settled: bool,
    pub is_paid: bool,
    pub bump: u8,
}

/// One posted history-batch root: a Merkle root over a batch of `PolicyClosed`
/// leaves, so an off-chain record is provable rather than trusted. A withheld
/// batch stays undetectable, which remains the keeper's assumption.
#[account]
#[derive(InitSpace)]
pub struct Registry {
    pub epoch: u64,
    pub root: [u8; 32],
    pub count: u64,
}
