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

/// Basis-point denominator for `PoolConfig::fee_bps` (1 bp = 1/100 of 1%).
#[constant]
pub const FEE_DENOMINATOR: u64 = 10_000;

/// Longest SLA the program will quote, measured from the current time.
///
/// Without a bound a policy can name a deadline the clock can never reach
/// (`i64::MAX`), and `settle_policy`'s maturity gate (`now >= deadline`) then
/// makes its locked risk unreleasable by anyone — including the attester
/// (pre-freeze audit: unreachable deadline).
#[constant]
pub const MAX_SLA_SECONDS: i64 = 365 * 24 * 60 * 60;
