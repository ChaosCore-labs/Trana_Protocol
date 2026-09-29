use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{constants::*, error::FreightDelayError, events::PoolInitialized, state::PoolConfig};

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = admin,
        seeds = [CONFIG_SEED, usdc_mint.key().as_ref()],
        bump,
        space = 8 + PoolConfig::INIT_SPACE,
    )]
    pub config: Account<'info, PoolConfig>,
    #[account(
        init,
        payer = admin,
        seeds = [TREASURY_SEED, config.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = config,
    )]
    pub treasury: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

impl<'info> InitializePool<'info> {
    pub fn initialize_pool(
        &mut self,
        fee_bps: u16,
        oracle_authority: Pubkey,
        bumps: InitializePoolBumps,
    ) -> Result<()> {
        require!(
            fee_bps <= FEE_DENOMINATOR as u16,
            FreightDelayError::InvalidFee
        );

        self.config.set_inner(PoolConfig {
            admin: self.admin.key(),
            oracle_authority,
            usdc_mint: self.usdc_mint.key(),
            treasury: self.treasury.key(),
            total_capital: 0,
            total_locked_risk: 0,
            total_shares: 0,
            total_fees: 0,
            fee_bps,
            bump: bumps.config,
        });

        emit!(PoolInitialized {
            config: self.config.key(),
            usdc_mint: self.usdc_mint.key(),
            treasury: self.treasury.key(),
            admin: self.admin.key(),
            oracle_authority,
            fee_bps,
        });

        Ok(())
    }
}
