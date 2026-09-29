use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::{
    constants::*,
    error::FreightDelayError,
    events::CapitalDeposited,
    state::{LpPosition, PoolConfig},
};

#[derive(Accounts)]
pub struct DepositCapital<'info> {
    #[account(mut)]
    pub lp: Signer<'info>,
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
        associated_token::mint = usdc_mint,
        associated_token::authority = lp,
    )]
    pub lp_usdc: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = lp,
        seeds = [LP_POSITION_SEED, config.key().as_ref(), lp.key().as_ref()],
        bump,
        space = 8 + LpPosition::INIT_SPACE,
    )]
    pub lp_position: Account<'info, LpPosition>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

impl<'info> DepositCapital<'info> {
    pub fn deposit_capital(&mut self, amount: u64, bumps: DepositCapitalBumps) -> Result<()> {
        require_neq!(amount, 0, FreightDelayError::InvalidAmount);

        let shares = if self.config.total_shares == 0 {
            amount
        } else {
            (amount as u128)
                .checked_mul(self.config.total_shares as u128)
                .and_then(|v| v.checked_div(self.config.total_capital as u128))
                .and_then(|v| u64::try_from(v).ok())
                .ok_or(FreightDelayError::MathOverflow)?
        };
        require_neq!(shares, 0, FreightDelayError::InvalidAmount);

        // `init_if_needed` zero-fills a freshly created position, so a default
        // `lp` distinguishes first deposit from a repeat deposit.
        if self.lp_position.lp == Pubkey::default() {
            self.lp_position.lp = self.lp.key();
            self.lp_position.bump = bumps.lp_position;
        }
        self.lp_position.shares = self
            .lp_position
            .shares
            .checked_add(shares)
            .ok_or(FreightDelayError::MathOverflow)?;

        self.config.total_shares = self
            .config
            .total_shares
            .checked_add(shares)
            .ok_or(FreightDelayError::MathOverflow)?;
        self.config.total_capital = self
            .config
            .total_capital
            .checked_add(amount)
            .ok_or(FreightDelayError::MathOverflow)?;

        token::transfer(
            CpiContext::new(
                self.token_program.key(),
                Transfer {
                    from: self.lp_usdc.to_account_info(),
                    to: self.treasury.to_account_info(),
                    authority: self.lp.to_account_info(),
                },
            ),
            amount,
        )?;

        self.config.assert_solvent()?;

        emit!(CapitalDeposited {
            config: self.config.key(),
            lp: self.lp.key(),
            amount,
            shares_minted: shares,
            total_capital: self.config.total_capital,
        });

        Ok(())
    }
}
