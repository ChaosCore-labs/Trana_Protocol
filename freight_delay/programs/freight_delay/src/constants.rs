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

/// Bound on where a policy's deadline (`expected_delivery + grace_period`) may
/// land, measured from purchase. An unreachable deadline makes the payout
/// unreleasable, and there is no timeout.
#[constant]
pub const MAX_SLA_SECONDS: i64 = 365 * 24 * 60 * 60;

/// Decimals the settlement mint must use: every amount in this program is USDC.
#[constant]
pub const USDC_DECIMALS: u8 = 6;

/// How far ahead of a pool's counter a buyer may place a `policy_id`: room for
/// concurrent quotes to pick distinct ids, far too narrow to spend a u64.
#[constant]
pub const MAX_POLICY_ID_GAP: u64 = 10_000;
