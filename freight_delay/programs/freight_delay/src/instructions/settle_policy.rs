use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{
    constants::*,
    error::FreightDelayError,
    events::PolicySettled,
    instructions::shared,
    state::{DeliveryReport, Policy, PoolConfig},
};

#[derive(Accounts)]
pub struct SettlePolicy<'info> {
    #[account(mut)]
    pub crank: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED, config.usdc_mint.as_ref()],
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
        seeds = [DELIVERY_SEED, policy.shipment_id.to_le_bytes().as_ref()],
        bump = delivery_report.bump,
    )]
    pub delivery_report: Account<'info, DeliveryReport>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = policy.insured,
    )]
    pub insured_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

impl<'info> SettlePolicy<'info> {
    pub fn settle_policy(&mut self) -> Result<()> {
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
        require!(
            self.delivery_report.shipment_id == self.policy.shipment_id,
            FreightDelayError::DeliveryMismatch
        );

        let payout = self.policy.payout_amount;
        let triggered = self.delivery_report.actual_delivery > deadline;

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
                &self.treasury,
                &self.insured_usdc,
                &self.config,
                payout,
            )?;

            self.policy.is_paid = true;
        }

        self.policy.is_settled = true;
        self.config.assert_solvent()?;

        emit!(PolicySettled {
            config: self.config.key(),
            policy: self.policy.key(),
            insured: self.policy.insured,
            triggered,
            payout_amount: payout,
            actual_delivery: self.delivery_report.actual_delivery,
            expected_delivery: self.policy.expected_delivery,
            grace_period: self.policy.grace_period,
        });

        Ok(())
    }
}
