use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::FreightDelayError,
    events::DeliveryReported,
    state::{DeliveryReport, PoolConfig},
};

#[derive(Accounts)]
#[instruction(shipment_id: u64)]
pub struct ReportDeliveryMilestone<'info> {
    #[account(mut)]
    pub reporter: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED, config.usdc_mint.as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, PoolConfig>,
    #[account(
        init,
        payer = reporter,
        seeds = [DELIVERY_SEED, shipment_id.to_le_bytes().as_ref()],
        bump,
        space = 8 + DeliveryReport::INIT_SPACE,
    )]
    pub delivery_report: Account<'info, DeliveryReport>,
    pub system_program: Program<'info, System>,
}

impl<'info> ReportDeliveryMilestone<'info> {
    pub fn report_delivery_milestone(
        &mut self,
        shipment_id: u64,
        actual_delivery: i64,
        terminal_code: u64,
        bumps: ReportDeliveryMilestoneBumps,
    ) -> Result<()> {
        require_keys_eq!(
            self.reporter.key(),
            self.config.oracle_authority,
            FreightDelayError::Unauthorized
        );

        self.delivery_report.set_inner(DeliveryReport {
            shipment_id,
            actual_delivery,
            terminal_code,
            timestamp: Clock::get()?.unix_timestamp,
            reporter: self.reporter.key(),
            bump: bumps.delivery_report,
        });

        emit!(DeliveryReported {
            config: self.config.key(),
            shipment_id,
            actual_delivery,
            terminal_code,
            timestamp: self.delivery_report.timestamp,
            reporter: self.reporter.key(),
        });

        Ok(())
    }
}
