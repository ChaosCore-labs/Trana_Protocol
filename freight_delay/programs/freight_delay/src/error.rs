use anchor_lang::prelude::*;

#[error_code]
pub enum FreightDelayError {
    #[msg("Only the configured authority may perform this action.")]
    Unauthorized,
    #[msg("Fee must be below 10,000 basis points.")]
    InvalidFee,
    #[msg("Amount must be greater than zero.")]
    InvalidAmount,
    #[msg("Expected delivery plus grace period must lie in the future and within the maximum SLA horizon.")]
    InvalidDeadline,
    #[msg("Pool is insolvent: locked risk would exceed total capital.")]
    Insolvent,
    #[msg("Pool does not have enough unencumbered capital for this withdrawal, or the withdrawal would leave none while shares remain.")]
    InsufficientFreeCapital,
    #[msg("Policy has not reached its delivery deadline plus grace period.")]
    PolicyNotMature,
    #[msg("Policy has already been settled.")]
    PolicyAlreadySettled,
    #[msg("Delivery report does not match the policy shipment.")]
    DeliveryMismatch,
    #[msg("Not enough shares to redeem.")]
    InsufficientShares,
    #[msg("Arithmetic overflow.")]
    MathOverflow,
    #[msg("Delivery attestation signature is missing or invalid.")]
    AttestationRejected,
    #[msg("Policy id must be greater than the last one issued for this pool, and within the id window.")]
    InvalidPolicyId,
    #[msg("Mint must use 6 decimals.")]
    InvalidMint,
}
