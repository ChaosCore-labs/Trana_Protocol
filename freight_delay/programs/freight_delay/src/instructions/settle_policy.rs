use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{
    constants::*,
    error::FreightDelayError,
    events::{DeliveryAttested, PolicySettled},
    instructions::shared::{self, DeliveryAttestation, verify_ed25519_attestation},
    state::{Policy, PoolConfig},
};

/// Instruction sysvar address, used to bind an attestation to this transaction.
const INSTRUCTIONS_ID: Pubkey = solana_instructions_sysvar::ID;

#[derive(Accounts)]
pub struct SettlePolicy<'info> {
    #[account(mut)]
    pub crank: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED, config.usdc_mint.as_ref(), config.oracle_authority.as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, PoolConfig>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [TREASURY_SEED, config.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = config,
    )]
    pub treasury: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [POLICY_SEED, config.key().as_ref(), policy.policy_id.to_le_bytes().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, Policy>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = policy.insured,
    )]
    pub insured_usdc: Account<'info, TokenAccount>,
    /// CHECK: the instructions sysvar, read for the precompile entry.
    #[account(address = INSTRUCTIONS_ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

impl<'info> SettlePolicy<'info> {
    pub fn settle_policy(
        &mut self,
        attestation: DeliveryAttestation,
        signature: [u8; 64],
    ) -> Result<()> {
        require!(
            !self.policy.is_settled,
            FreightDelayError::PolicyAlreadySettled
        );

        let deadline = self
            .policy
            .expected_delivery
            .checked_add(self.policy.grace_period)
            .ok_or(FreightDelayError::MathOverflow)?;
        require!(
            Clock::get()?.unix_timestamp >= deadline,
            FreightDelayError::PolicyNotMature
        );

        // The nonce is the replay bound: a signature can only ever settle the one
        // policy it was minted for.
        require!(
            attestation.shipment_id == self.policy.shipment_id,
            FreightDelayError::DeliveryMismatch
        );
        require!(
            attestation.nonce == self.policy.policy_id,
            FreightDelayError::AttestationRejected
        );

        verify_ed25519_attestation(
            &self.instructions.to_account_info(),
            &self.config.oracle_authority.to_bytes(),
            &attestation.to_message(&self.config.key()),
            &signature,
        )?;

        let payout = self.policy.payout_amount;
        let triggered = attestation.actual_delivery > deadline;

        self.config.total_locked_risk = self
            .config
            .total_locked_risk
            .checked_sub(payout)
            .ok_or(FreightDelayError::MathOverflow)?;

        if triggered {
            self.config.total_capital = self
                .config
                .total_capital
                .checked_sub(payout)
                .ok_or(FreightDelayError::InsufficientFreeCapital)?;

            shared::transfer_from_treasury(
                &self.token_program,
                &self.usdc_mint,
                &self.treasury,
                &self.insured_usdc,
                &self.config,
                payout,
            )?;

            self.policy.is_paid = true;
        }

        self.policy.is_settled = true;
        self.config.assert_solvent()?;

        // The on-chain record of what the oracle attested, emitted for every
        // settlement so the delivery history is reconstructible off-chain.
        emit!(DeliveryAttested {
            config: self.config.key(),
            policy: self.policy.key(),
            shipment_id: attestation.shipment_id,
            actual_delivery: attestation.actual_delivery,
            terminal_code: attestation.terminal_code,
            nonce: attestation.nonce,
        });

        emit!(PolicySettled {
            config: self.config.key(),
            policy: self.policy.key(),
            insured: self.policy.insured,
            triggered,
            payout_amount: payout,
            actual_delivery: attestation.actual_delivery,
            expected_delivery: self.policy.expected_delivery,
            grace_period: self.policy.grace_period,
        });

        Ok(())
    }
}
