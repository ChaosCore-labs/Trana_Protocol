use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount, Transfer, transfer};
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use solana_sdk_ids::ed25519_program;

use crate::{constants::CONFIG_SEED, error::FreightDelayError, state::PoolConfig};

/// The signed delivery attestation produced off-chain by the attester.
///
/// Field order and width are the contract with `attester/src/payload.ts`. Any
/// change here is breaking on both sides.
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct DeliveryAttestation {
    pub shipment_id: u64,
    pub actual_delivery: i64,
    pub terminal_code: u64,
    pub nonce: u64,
}

impl DeliveryAttestation {
    /// The canonical 64-byte message the attester signs: the pool it is for,
    /// then the delivery fields.
    ///
    /// Binding the pool is what keeps a signature single-pool: `nonce` alone
    /// bounds replay within one pool, because the id it must match is chosen by
    /// the buyer, and every pool's ids start from the same space.
    pub fn to_message(&self, pool: &Pubkey) -> [u8; 64] {
        let mut buf = [0u8; 64];
        buf[0..32].copy_from_slice(pool.as_ref());
        buf[32..40].copy_from_slice(&self.shipment_id.to_le_bytes());
        buf[40..48].copy_from_slice(&self.actual_delivery.to_le_bytes());
        buf[48..56].copy_from_slice(&self.terminal_code.to_le_bytes());
        buf[56..64].copy_from_slice(&self.nonce.to_le_bytes());
        buf
    }
}

/// Verify an ed25519 signature over `message` by `attester_pubkey`, requiring
/// the signature to also appear as an ed25519 precompile instruction earlier in
/// this same transaction.
///
/// Not a replay guard: the precompile is deterministic, so the same bytes pass
/// this scan again in a later transaction. The `nonce` stops replay.
pub fn verify_ed25519_attestation(
    instructions_sysvar: &AccountInfo,
    attester_pubkey: &[u8; 32],
    message: &[u8; 64],
    signature: &[u8; 64],
) -> Result<()> {
    let current_index = load_current_index_checked(instructions_sysvar)
        .map_err(|_| FreightDelayError::AttestationRejected)?;

    let mut found = false;
    for index in 0..current_index {
        let ix = match load_instruction_at_checked(index as usize, instructions_sysvar) {
            Ok(ix) => ix,
            Err(_) => continue,
        };
        if ix.program_id != ed25519_program::ID {
            continue;
        }
        if ed25519_ix_matches(&ix.data, attester_pubkey, message, signature) {
            found = true;
            break;
        }
    }

    require!(found, FreightDelayError::AttestationRejected);
    Ok(())
}

/// Does this ed25519 precompile instruction carry exactly our key, message and
/// signature, inline rather than by reference?
///
/// Header offsets, all u16 LE into this instruction's own data:
///   [2] signature_offset  [4] signature_instruction_index
///   [6] public_key_offset [8] public_key_instruction_index
///   [10] message_offset   [12] message_size
///   [14] message_instruction_index
///
/// An instruction index of 0xFFFF means "inline in this instruction".
fn ed25519_ix_matches(
    data: &[u8],
    pubkey: &[u8; 32],
    message: &[u8],
    signature: &[u8; 64],
) -> bool {
    /// `0xFFFF` marks data carried inline in the precompile instruction itself.
    const SELF: u16 = 0xFFFF;
    const HEADER: usize = 16;

    if data.len() < HEADER || data[0] != 1 {
        return false;
    }
    let read_u16 = |at: usize| u16::from_le_bytes([data[at], data[at + 1]]);

    let sig_off = read_u16(2) as usize;
    let pk_off = read_u16(6) as usize;
    let msg_off = read_u16(10) as usize;
    let msg_size = read_u16(12) as usize;

    if read_u16(4) != SELF || read_u16(8) != SELF || read_u16(14) != SELF || msg_size != message.len()
    {
        return false;
    }

    let slice = |off: usize, len: usize| -> Option<&[u8]> {
        let end = off.checked_add(len)?;
        data.get(off..end)
    };

    match (
        slice(sig_off, 64),
        slice(pk_off, 32),
        slice(msg_off, message.len()),
    ) {
        (Some(s), Some(p), Some(m)) => s == signature && p == pubkey && m == message,
        _ => false,
    }
}

/// Transfers `amount` out of the pool treasury, signed by the `PoolConfig` PDA.
pub fn transfer_from_treasury<'info>(
    token_program: &Program<'info, Token>,
    treasury: &Account<'info, TokenAccount>,
    recipient: &Account<'info, TokenAccount>,
    config: &Account<'info, PoolConfig>,
    amount: u64,
) -> Result<()> {
    let seeds: &[&[u8]] = &[
        CONFIG_SEED,
        config.usdc_mint.as_ref(),
        config.oracle_authority.as_ref(),
        &[config.bump],
    ];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    transfer(
        CpiContext::new_with_signer(
            token_program.key(),
            Transfer {
                from: treasury.to_account_info(),
                to: recipient.to_account_info(),
                authority: config.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A precompile payload with the given `message_instruction_index`.
    ///
    /// These tests build malformed headers on purpose, so the real encoder
    /// cannot be used here.
    fn precompile_data(msg_ix: u16) -> Vec<u8> {
        let pubkey = [1u8; 32];
        let signature = [2u8; 64];
        let message = [3u8; 64];

        let mut data = Vec::with_capacity(16 + 32 + 64 + 64);
        data.push(1); // num_signatures
        data.push(0); // padding
        data.extend_from_slice(&48u16.to_le_bytes()); // signature_offset
        data.extend_from_slice(&0xFFFFu16.to_le_bytes()); // signature_ix
        data.extend_from_slice(&16u16.to_le_bytes()); // public_key_offset
        data.extend_from_slice(&0xFFFFu16.to_le_bytes()); // public_key_ix
        data.extend_from_slice(&112u16.to_le_bytes()); // message_data_offset
        data.extend_from_slice(&64u16.to_le_bytes()); // message_data_size
        data.extend_from_slice(&msg_ix.to_le_bytes()); // message_instruction_index
        data.extend_from_slice(&pubkey);
        data.extend_from_slice(&signature);
        data.extend_from_slice(&message);
        data
    }

    const PUBKEY: [u8; 32] = [1u8; 32];
    const MESSAGE: [u8; 64] = [3u8; 64];
    const SIGNATURE: [u8; 64] = [2u8; 64];

    #[test]
    fn accepts_an_inline_attestation() {
        let data = precompile_data(0xFFFF);
        assert!(ed25519_ix_matches(&data, &PUBKEY, &MESSAGE, &SIGNATURE));
    }

    #[test]
    fn rejects_a_header_whose_high_byte_is_not_0xff() {
        // Only 0xFFFF means "inline". 0x00FF has a low byte of 0xFF, so a
        // low-byte-only comparison accepts it.
        let data = precompile_data(0x00FF);
        assert!(!ed25519_ix_matches(&data, &PUBKEY, &MESSAGE, &SIGNATURE));
    }

    #[test]
    fn rejects_a_header_pointing_at_another_instruction() {
        let data = precompile_data(1);
        assert!(!ed25519_ix_matches(&data, &PUBKEY, &MESSAGE, &SIGNATURE));
    }

    #[test]
    fn rejects_a_by_reference_signature_or_key() {
        // Same guard, for the other two index fields.
        let mut data = precompile_data(0xFFFF);
        data[5] = 0x00; // signature_instruction_index high byte
        assert!(!ed25519_ix_matches(&data, &PUBKEY, &MESSAGE, &SIGNATURE));

        let mut data = precompile_data(0xFFFF);
        data[9] = 0x00; // public_key_instruction_index high byte
        assert!(!ed25519_ix_matches(&data, &PUBKEY, &MESSAGE, &SIGNATURE));
    }

    #[test]
    fn rejects_a_mismatched_message_or_key_or_signature() {
        let data = precompile_data(0xFFFF);
        assert!(!ed25519_ix_matches(&data, &[9u8; 32], &MESSAGE, &SIGNATURE));
        assert!(!ed25519_ix_matches(&data, &PUBKEY, &[9u8; 64], &SIGNATURE));
        assert!(!ed25519_ix_matches(&data, &PUBKEY, &MESSAGE, &[9u8; 64]));
    }

    #[test]
    fn rejects_a_truncated_or_multi_signature_payload() {
        assert!(!ed25519_ix_matches(&[0u8; 15], &PUBKEY, &MESSAGE, &SIGNATURE));

        let mut many = precompile_data(0xFFFF);
        many[0] = 2; // num_signatures != 1
        assert!(!ed25519_ix_matches(&many, &PUBKEY, &MESSAGE, &SIGNATURE));
    }

    #[test]
    fn rejects_an_offset_that_runs_past_the_end() {
        let mut data = precompile_data(0xFFFF);
        // Move the message past the buffer.
        data[10..12].copy_from_slice(&900u16.to_le_bytes());
        assert!(!ed25519_ix_matches(&data, &PUBKEY, &MESSAGE, &SIGNATURE));
    }
}
