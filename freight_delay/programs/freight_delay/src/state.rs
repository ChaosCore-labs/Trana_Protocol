use anchor_lang::prelude::*;

use crate::error::FreightDelayError;

/// Global pool state. One pool per USDC mint.
#[account]
#[derive(InitSpace)]
pub struct PoolConfig {
    pub admin: Pubkey,
    /// Sole signer allowed to write `DeliveryReport` accounts.
    pub oracle_authority: Pubkey,
    pub usdc_mint: Pubkey,
    /// Program-owned token account that holds all pool liquidity.
    pub treasury: Pubkey,
    /// Deposited capital plus net premiums, minus realised payouts.
    pub total_capital: u64,
    /// Sum of `payout_amount` across unsettled policies.
    pub total_locked_risk: u64,
    pub total_shares: u64,
    pub total_fees: u64,
    pub fee_bps: u16,
    pub bump: u8,
}

impl PoolConfig {
    /// Capital not reserved against an outstanding policy payout.
    pub fn free_capital(&self) -> u64 {
        self.total_capital.saturating_sub(self.total_locked_risk)
    }

    /// Full-collateralisation invariant: every payout must be backed by capital.
    pub fn assert_solvent(&self) -> Result<()> {
        require!(
            self.total_locked_risk <= self.total_capital,
            FreightDelayError::Insolvent
        );
        Ok(())
    }
}

/// Per-liquidity-provider share position.
#[account]
#[derive(InitSpace)]
pub struct LpPosition {
    pub lp: Pubkey,
    pub shares: u64,
    pub bump: u8,
}

/// A single parametric delay hedge written against a shipment's SLA.
#[account]
#[derive(InitSpace)]
pub struct Policy {
    pub insured: Pubkey,
    pub policy_id: u64,
    /// Bill of lading / container identifier matched against a `DeliveryReport`.
    pub shipment_id: u64,
    /// SLA delivery timestamp the shipment was quoted.
    pub expected_delivery: i64,
    /// Slack after `expected_delivery` before a late arrival triggers a payout.
    pub grace_period: i64,
    pub payout_amount: u64,
    pub premium_amount: u64,
    pub is_settled: bool,
    pub is_paid: bool,
    pub bump: u8,
}

/// Oracle-attested delivery milestone for a shipment.
#[account]
#[derive(InitSpace)]
pub struct DeliveryReport {
    pub shipment_id: u64,
    pub actual_delivery: i64,
    pub terminal_code: u64,
    pub timestamp: i64,
    pub reporter: Pubkey,
    pub bump: u8,
}
