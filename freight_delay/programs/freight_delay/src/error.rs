use anchor_lang::prelude::*;

#[error_code]
pub enum FreightDelayError {
    #[msg("Only the configured authority may perform this action.")]
    Unauthorized,
    #[msg("Fee must be between 0 and 10,000 basis points.")]
    InvalidFee,
    #[msg("Amount must be greater than zero.")]
    InvalidAmount,
    #[msg("Expected delivery must be in the future with a non-negative grace period.")]
    InvalidDeadline,
    #[msg("Pool is insolvent: locked risk would exceed total capital.")]
    Insolvent,
    #[msg("Pool does not have enough unencumbered capital for this withdrawal.")]
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
}
