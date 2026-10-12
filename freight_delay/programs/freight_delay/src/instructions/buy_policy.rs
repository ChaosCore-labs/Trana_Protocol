use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::{
    constants::*,
    error::FreightDelayError,
    events::PolicyPurchased,
    state::{Policy, PoolConfig},
};

#[derive(Accounts)]
#[instruction(policy_id: u64)]
pub struct BuyPolicy<'info> {
    #[account(mut)]
    pub insured: Signer<'info>,
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
        associated_token::mint = usdc_mint,
        associated_token::authority = insured,
    )]
    pub insured_usdc: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = insured,
        seeds = [POLICY_SEED, config.key().as_ref(), policy_id.to_le_bytes().as_ref()],
        bump,
        space = 8 + Policy::INIT_SPACE,
    )]
    pub policy: Account<'info, Policy>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

impl<'info> BuyPolicy<'info> {
    #[allow(clippy::too_many_arguments)]
    pub fn buy_policy(
        &mut self,
        policy_id: u64,
        shipment_id: u64,
        expected_delivery: i64,
        grace_period: i64,
        payout_amount: u64,
        premium_amount: u64,
        bumps: BuyPolicyBumps,
    ) -> Result<()> {
        require_neq!(payout_amount, 0, FreightDelayError::InvalidAmount);
        require_neq!(premium_amount, 0, FreightDelayError::InvalidAmount);
        let now = Clock::get()?.unix_timestamp;
        require!(expected_delivery > now, FreightDelayError::InvalidDeadline);
        require!(grace_period >= 0, FreightDelayError::InvalidDeadline);
        // The deadline, not only the quote, has to land inside the horizon: no
        // timeout path exists, so an unreachable one locks the payout for good.
        let horizon = now
            .checked_add(MAX_SLA_SECONDS)
            .ok_or(FreightDelayError::InvalidDeadline)?;
        let deadline = expected_delivery
            .checked_add(grace_period)
            .ok_or(FreightDelayError::InvalidDeadline)?;
        require!(deadline <= horizon, FreightDelayError::InvalidDeadline);
        // `nonce` is the policy id, so a reused id would let an attestation signed
        // for a closed policy settle a new one, and a runaway id would spend the
        // remaining id space out from under every later policy.
        require!(
            policy_id > self.config.last_policy_id
                && policy_id - self.config.last_policy_id <= MAX_POLICY_ID_GAP,
            FreightDelayError::InvalidPolicyId
        );
        self.config.last_policy_id = policy_id;
        require!(
            self.config.free_capital() >= payout_amount,
            FreightDelayError::Insolvent
        );

        let fee = (premium_amount as u128)
            .checked_mul(self.config.fee_bps as u128)
            .and_then(|v| v.checked_div(FEE_DENOMINATOR as u128))
            .and_then(|v| u64::try_from(v).ok())
            .ok_or(FreightDelayError::MathOverflow)?;
        let net_premium = premium_amount
            .checked_sub(fee)
            .ok_or(FreightDelayError::MathOverflow)?;

        self.config.total_capital = self
            .config
            .total_capital
            .checked_add(net_premium)
            .ok_or(FreightDelayError::MathOverflow)?;
        self.config.total_fees = self
            .config
            .total_fees
            .checked_add(fee)
            .ok_or(FreightDelayError::MathOverflow)?;
        self.config.total_locked_risk = self
            .config
            .total_locked_risk
            .checked_add(payout_amount)
            .ok_or(FreightDelayError::MathOverflow)?;

        token::transfer_checked(
            CpiContext::new(
                self.token_program.key(),
                TransferChecked {
                    from: self.insured_usdc.to_account_info(),
                    mint: self.usdc_mint.to_account_info(),
                    to: self.treasury.to_account_info(),
                    authority: self.insured.to_account_info(),
                },
            ),
            premium_amount,
            self.usdc_mint.decimals,
        )?;

        self.policy.set_inner(Policy {
            insured: self.insured.key(),
            policy_id,
            shipment_id,
            expected_delivery,
            grace_period,
            payout_amount,
            premium_amount,
            is_settled: false,
            is_paid: false,
            bump: bumps.policy,
        });

        self.config.assert_solvent()?;

        emit!(PolicyPurchased {
            config: self.config.key(),
            policy: self.policy.key(),
            insured: self.insured.key(),
            policy_id,
            shipment_id,
            expected_delivery,
            grace_period,
            payout_amount,
            premium_amount,
        });

        Ok(())
    }
}
