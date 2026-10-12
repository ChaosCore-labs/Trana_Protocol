use anchor_lang::prelude::*;

use crate::error::FreightDelayError;

/// Global pool state. One pool per (USDC mint, attester) pair: the seeds carry
/// the attester's key, so a pool cannot be created — or squatted — without it.
#[account]
#[derive(InitSpace)]
pub struct PoolConfig {
    pub admin: Pubkey,
    /// The attester's raw 32-byte ed25519 public key, not a wallet address.
    /// `settle_policy` accepts only an attestation signed by this key.
    pub oracle_authority: Pubkey,
    /// The only key allowed to post history-batch roots (CHA-18). Set at init and
    /// never changeable, like every other authority in this pool.
    pub keeper: Pubkey,
    pub usdc_mint: Pubkey,
    /// Program-owned token account that holds all pool liquidity.
    pub treasury: Pubkey,
    /// Deposited capital plus net premiums, minus realised payouts.
    pub total_capital: u64,
    /// Sum of `payout_amount` across unsettled policies.
    pub total_locked_risk: u64,
    pub total_shares: u64,
    pub total_fees: u64,
    /// The highest `policy_id` issued so far. Ids must strictly increase and are
    /// never reused, even after a policy's PDA is closed: the attester's `nonce`
    /// is the policy id, so a repeated id would let a stale attestation settle a
    /// policy it was not signed for (CHA-18).
    pub last_policy_id: u64,
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
    /// Bill of lading / container identifier, matched against a settlement attestation.
    pub shipment_id: u64,
    /// SLA timestamp the shipment was quoted: the **destination-terminal arrival**
    /// the attester measures against, not a door-delivery time (CHA-33).
    pub expected_delivery: i64,
    /// Slack after `expected_delivery` before a late arrival triggers a payout.
    /// Not bounded on chain: a grace period approaching the corridor's transit
    /// time sells a policy that can practically never trigger.
    pub grace_period: i64,
    pub payout_amount: u64,
    pub premium_amount: u64,
    pub is_settled: bool,
    pub is_paid: bool,
    pub bump: u8,
}

/// One posted history-batch root (CHA-18). The keeper writes one per batch of
/// policies closed since the last epoch; `root` is a Merkle root over that
/// batch's `PolicyClosed` leaves, and `count` is how many leaves it covers.
///
/// This makes the off-chain policy database verifiable rather than trusted:
/// anyone holding the batch data can prove a policy's inclusion against the
/// root, so a forged record is detectable. Batch withholding is the residual
/// assumption — the program cannot tell a withheld batch from one never posted.
#[account]
#[derive(InitSpace)]
pub struct Registry {
    pub epoch: u64,
    pub root: [u8; 32],
    pub count: u64,
}
