use anchor_lang::prelude::*;

use crate::{
    constants::{CONFIG_SEED, REGISTRY_SEED},
    error::FreightDelayError,
    events::RootPosted,
    state::{PoolConfig, Registry},
};

/// Keeper-signed, one `Registry` PDA per epoch. The program cannot verify a Merkle
/// root on chain, so it authenticates the poster and stores the root; anyone with
/// the batch data can prove inclusion. A withheld batch stays undetectable.
#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct PostRoot<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED, config.usdc_mint.as_ref(), config.oracle_authority.as_ref()],
        bump = config.bump,
        constraint = keeper.key() == config.keeper @ FreightDelayError::Unauthorized,
    )]
    pub config: Account<'info, PoolConfig>,
    #[account(
        init,
        payer = keeper,
        seeds = [REGISTRY_SEED, config.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump,
        space = 8 + Registry::INIT_SPACE,
    )]
    pub registry: Account<'info, Registry>,
    pub system_program: Program<'info, System>,
}

impl<'info> PostRoot<'info> {
    pub fn post_root(&mut self, epoch: u64, root: [u8; 32], count: u64) -> Result<()> {
        self.registry.set_inner(Registry { epoch, root, count });

        emit!(RootPosted {
            config: self.config.key(),
            epoch,
            root,
            count,
        });

        Ok(())
    }
}
