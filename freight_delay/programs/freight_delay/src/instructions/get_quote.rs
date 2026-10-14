use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::FreightDelayError,
    events::QuoteCreated,
    state::{PoolConfig, Quote},
};

/// The terms `get_quote` authors, passed as one argument. An offer is a single
/// object, and eight positional numbers say less at a call site than one name.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct QuoteTerms {
    pub quote_id: u64,
    pub shipment_id: u64,
    pub expected_delivery: i64,
    pub grace_period: i64,
    pub payout_amount: u64,
    pub premium_amount: u64,
    /// `Pubkey::default()` leaves the quote open to any buyer.
    pub buyer: Pubkey,
    pub expires_at: i64,
}

#[derive(Accounts)]
#[instruction(terms: QuoteTerms)]
pub struct GetQuote<'info> {
    #[account(mut)]
    pub underwriter: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED, config.usdc_mint.as_ref(), config.oracle_authority.as_ref()],
        bump = config.bump,
        constraint = underwriter.key() == config.underwriter @ FreightDelayError::Unauthorized,
    )]
    pub config: Account<'info, PoolConfig>,
    #[account(
        init,
        payer = underwriter,
        seeds = [QUOTE_SEED, config.key().as_ref(), terms.quote_id.to_le_bytes().as_ref()],
        bump,
        space = 8 + Quote::INIT_SPACE,
    )]
    pub quote: Account<'info, Quote>,
    pub system_program: Program<'info, System>,
}

impl<'info> GetQuote<'info> {
    pub fn get_quote(&mut self, terms: QuoteTerms, bumps: GetQuoteBumps) -> Result<()> {
        let QuoteTerms {
            quote_id,
            shipment_id,
            expected_delivery,
            grace_period,
            payout_amount,
            premium_amount,
            buyer,
            expires_at,
        } = terms;

        require_neq!(payout_amount, 0, FreightDelayError::InvalidAmount);
        require_neq!(premium_amount, 0, FreightDelayError::InvalidAmount);

        let now = Clock::get()?.unix_timestamp;
        require!(expected_delivery > now, FreightDelayError::InvalidDeadline);
        require!(grace_period >= 0, FreightDelayError::InvalidDeadline);
        // No timeout path exists, so an unreachable deadline locks the payout for
        // good. Measuring the ceiling from authoring time still holds at purchase,
        // which is never earlier.
        let horizon = now
            .checked_add(MAX_SLA_SECONDS)
            .ok_or(FreightDelayError::InvalidDeadline)?;
        let deadline = expected_delivery
            .checked_add(grace_period)
            .ok_or(FreightDelayError::InvalidDeadline)?;
        require!(deadline <= horizon, FreightDelayError::InvalidDeadline);
        // A quote outliving the expected arrival could be bought with the delay
        // already known; expiry at or before it keeps the risk uncertain at
        // inception, and how much earlier it lapses stays the underwriter's call.
        require!(
            expires_at > now && expires_at <= expected_delivery,
            FreightDelayError::InvalidExpiry
        );

        self.quote.set_inner(Quote {
            underwriter: self.underwriter.key(),
            buyer,
            quote_id,
            shipment_id,
            expected_delivery,
            grace_period,
            payout_amount,
            premium_amount,
            expires_at,
            bump: bumps.quote,
        });

        emit!(QuoteCreated {
            config: self.config.key(),
            quote: self.quote.key(),
            underwriter: self.underwriter.key(),
            buyer,
            quote_id,
            shipment_id,
            expected_delivery,
            grace_period,
            payout_amount,
            premium_amount,
            expires_at,
        });

        Ok(())
    }
}
