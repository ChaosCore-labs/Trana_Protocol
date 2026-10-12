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

declare_id!("4BtUosFfNUySEGAGspfjvStCzLzqSRdfoc4Z3Z1uqGJs");

#[program]
pub mod freight_delay {
    use super::*;

    pub fn initialize_pool(ctx: Context<InitializePool>, fee_bps: u16, keeper: Pubkey) -> Result<()> {
        ctx.accounts.initialize_pool(fee_bps, keeper, ctx.bumps)
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

    pub fn settle_policy(
        ctx: Context<SettlePolicy>,
        attestation: instructions::shared::DeliveryAttestation,
        signature: [u8; 64],
    ) -> Result<()> {
        ctx.accounts.settle_policy(attestation, signature)
    }

    pub fn withdraw_capital(ctx: Context<WithdrawCapital>, shares: u64) -> Result<()> {
        ctx.accounts.withdraw_capital(shares)
    }

    pub fn post_root(
        ctx: Context<PostRoot>,
        epoch: u64,
        root: [u8; 32],
        count: u64,
    ) -> Result<()> {
        ctx.accounts.post_root(epoch, root, count)
    }
}
