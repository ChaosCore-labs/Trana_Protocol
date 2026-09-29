use anchor_lang::prelude::*;

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";

#[constant]
pub const TREASURY_SEED: &[u8] = b"treasury";

#[constant]
pub const LP_POSITION_SEED: &[u8] = b"lp_position";

#[constant]
pub const POLICY_SEED: &[u8] = b"policy";

#[constant]
pub const DELIVERY_SEED: &[u8] = b"delivery";

/// Basis-point denominator for `PoolConfig::fee_bps` (1 bp = 1/100 of 1%).
#[constant]
pub const FEE_DENOMINATOR: u64 = 10_000;
