pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use events::*;
pub use instructions::*;
pub use state::*;

declare_id!("HKygNZod2WmpPzDVHjcdv7kpd74t68zH9sE4Kp1mxAQP");

#[program]
pub mod freight_delay {
    use super::*;

    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        fee_bps: u16,
        oracle_authority: Pubkey,
    ) -> Result<()> {
        ctx.accounts
            .initialize_pool(fee_bps, oracle_authority, ctx.bumps)
    }

    pub fn deposit_capital(ctx: Context<DepositCapital>, amount: u64) -> Result<()> {
        ctx.accounts.deposit_capital(amount, ctx.bumps)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn buy_policy(
        ctx: Context<BuyPolicy>,
        policy_id: u64,
        shipment_id: u64,
        expected_delivery: i64,
        grace_period: i64,
        payout_amount: u64,
        premium_amount: u64,
    ) -> Result<()> {
        ctx.accounts.buy_policy(
            policy_id,
            shipment_id,
            expected_delivery,
            grace_period,
            payout_amount,
            premium_amount,
            ctx.bumps,
        )
    }

    pub fn report_delivery_milestone(
        ctx: Context<ReportDeliveryMilestone>,
        shipment_id: u64,
        actual_delivery: i64,
        terminal_code: u64,
    ) -> Result<()> {
        ctx.accounts.report_delivery_milestone(
            shipment_id,
            actual_delivery,
            terminal_code,
            ctx.bumps,
        )
    }

    pub fn settle_policy(ctx: Context<SettlePolicy>) -> Result<()> {
        ctx.accounts.settle_policy()
    }

    pub fn withdraw_capital(ctx: Context<WithdrawCapital>, shares: u64) -> Result<()> {
        ctx.accounts.withdraw_capital(shares)
    }
}
