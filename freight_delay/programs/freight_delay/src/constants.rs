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
pub const REGISTRY_SEED: &[u8] = b"registry";

#[constant]
pub const FEE_DENOMINATOR: u64 = 10_000;

/// Bound on how far ahead `expected_delivery` may point. A deadline the clock
/// cannot reach would make the payout unreleasable, and there is no timeout.
#[constant]
pub const MAX_SLA_SECONDS: i64 = 365 * 24 * 60 * 60;
