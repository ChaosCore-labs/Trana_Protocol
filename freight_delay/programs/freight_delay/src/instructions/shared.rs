use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount, Transfer, transfer};
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use crate::{constants::CONFIG_SEED, error::FreightDelayError, state::PoolConfig};

/// The native ed25519 signature-verification program.
const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

/// The signed delivery attestation produced off-chain by the attester.
///
/// Field order and width are the contract with `attester/src/payload.ts`:
/// 32 bytes, little-endian — `shipment_id u64`, `actual_delivery i64`,
/// `terminal_code u64`, `nonce u64`. Changing either side is a breaking change
/// to both.
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct DeliveryAttestation {
    pub shipment_id: u64,
    pub actual_delivery: i64,
    pub terminal_code: u64,
    pub nonce: u64,
}

impl DeliveryAttestation {
    /// The canonical 32-byte message the attester signs.
    pub fn to_message(&self) -> [u8; 32] {
        let mut buf = [0u8; 32];
        buf[0..8].copy_from_slice(&self.shipment_id.to_le_bytes());
        buf[8..16].copy_from_slice(&self.actual_delivery.to_le_bytes());
        buf[16..24].copy_from_slice(&self.terminal_code.to_le_bytes());
        buf[24..32].copy_from_slice(&self.nonce.to_le_bytes());
        buf
    }
}

/// Verify an ed25519 signature over `message` by `attester_pubkey`, where the
/// signature must have been submitted as an ed25519 precompile instruction
/// **earlier in this same transaction**.
///
/// The sysvar scan is the part that matters. The precompile proves a signature
/// is valid; only binding to the instruction sysvar proves it was made for THIS
/// transaction. Without it, any historical signature replays forever.
pub fn verify_ed25519_attestation(
    instructions_sysvar: &AccountInfo,
    attester_pubkey: &[u8; 32],
    message: &[u8; 32],
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
        if ix.program_id != ED25519_PROGRAM_ID {
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
/// signature, inline in this instruction (not by reference to another one)?
///
/// Precompile data layout (16-byte header, then the entries):
///   [0]     num_signatures (u8)
///   [1]     padding
///   [2..4]  signature_offset            (u16 LE, into this same data)
///   [4..6]  signature_instruction_index (0xFFFF = this instruction)
///   [6..8]  public_key_offset           (u16 LE)
///   [8..10] public_key_instruction_index (0xFFFF)
///   [10..12] message_data_offset        (u16 LE)
///   [12..14] message_data_size          (u16 LE)
///   [14..16] message_instruction_index  (0xFFFF)
fn ed25519_ix_matches(
    data: &[u8],
    pubkey: &[u8; 32],
    message: &[u8; 32],
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

    if read_u16(4) != SELF || read_u16(8) != SELF || data[14] != 0xFF || msg_size != 32 {
        return false;
    }

    let slice = |off: usize, len: usize| -> Option<&[u8]> {
        let end = off.checked_add(len)?;
        data.get(off..end)
    };

    match (slice(sig_off, 64), slice(pk_off, 32), slice(msg_off, 32)) {
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
    let seeds: &[&[u8]] = &[CONFIG_SEED, config.usdc_mint.as_ref(), &[config.bump]];
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
