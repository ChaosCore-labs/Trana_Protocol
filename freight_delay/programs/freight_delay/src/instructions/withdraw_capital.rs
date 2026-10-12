use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{
    constants::*,
    error::FreightDelayError,
    events::CapitalWithdrawn,
    instructions::shared,
    state::{LpPosition, PoolConfig},
};

#[derive(Accounts)]
pub struct WithdrawCapital<'info> {
    #[account(mut)]
    pub lp: Signer<'info>,
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
        associated_token::authority = lp,
    )]
    pub lp_usdc: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [LP_POSITION_SEED, config.key().as_ref(), lp.key().as_ref()],
        bump = lp_position.bump,
        constraint = lp_position.lp == lp.key() @ FreightDelayError::Unauthorized,
    )]
    pub lp_position: Account<'info, LpPosition>,
    pub token_program: Program<'info, Token>,
}

impl<'info> WithdrawCapital<'info> {
    pub fn withdraw_capital(&mut self, shares: u64) -> Result<()> {
        require_neq!(shares, 0, FreightDelayError::InvalidAmount);
        require!(
            shares <= self.lp_position.shares,
            FreightDelayError::InsufficientShares
        );

        let amount = (shares as u128)
            .checked_mul(self.config.total_capital as u128)
            .and_then(|v| v.checked_div(self.config.total_shares as u128))
            .and_then(|v| u64::try_from(v).ok())
            .ok_or(FreightDelayError::MathOverflow)?;
        require_neq!(amount, 0, FreightDelayError::InvalidAmount);
        require!(
            amount <= self.config.free_capital(),
            FreightDelayError::InsufficientFreeCapital
        );

        self.lp_position.shares = self
            .lp_position
            .shares
            .checked_sub(shares)
            .ok_or(FreightDelayError::MathOverflow)?;
        self.config.total_shares = self
            .config
            .total_shares
            .checked_sub(shares)
            .ok_or(FreightDelayError::MathOverflow)?;
        self.config.total_capital = self
            .config
            .total_capital
            .checked_sub(amount)
            .ok_or(FreightDelayError::MathOverflow)?;

        // A pool with shares outstanding has to keep some capital free, or the next
        // triggered settlement takes `total_capital` to exactly zero and both pricing
        // divisions die on it — the pool could never be deposited into or redeemed
        // again (pre-freeze audit: zero-capital brick). A full exit is exempt: `total_shares == 0`
        // means there is nobody left to strand.
        require!(
            self.config.total_shares == 0 || self.config.free_capital() > 0,
            FreightDelayError::InsufficientFreeCapital
        );

        shared::transfer_from_treasury(
            &self.token_program,
            &self.usdc_mint,
            &self.treasury,
            &self.lp_usdc,
            &self.config,
            amount,
        )?;

        self.config.assert_solvent()?;

        emit!(CapitalWithdrawn {
            config: self.config.key(),
            lp: self.lp.key(),
            shares_burned: shares,
            amount,
            total_capital: self.config.total_capital,
        });

        // A position with no shares left is dead weight: close it and return the
        // rent to the LP. `deposit_capital` recreates it via `init_if_needed`, so
        // an LP that comes back gets a fresh position at the same address.
        if self.lp_position.shares == 0 {
            self.lp_position.close(self.lp.to_account_info())?;
        }

        Ok(())
    }
}
