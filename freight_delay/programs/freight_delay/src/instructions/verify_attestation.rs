use anchor_lang::prelude::*;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use crate::error::FreightDelayError;

/// The instructions sysvar's address.
const INSTRUCTIONS_ID: Pubkey = solana_instructions_sysvar::ID;

/// The native ed25519 signature-verification program.
const ED25519_PROGRAM_ID: Pubkey =
    pubkey!("Ed25519SigVerify111111111111111111111111111");

/// The signed delivery attestation produced off-chain by the attester.
///
/// Field order and width are the contract with `attester/src/payload.ts`:
/// 32 bytes, little-endian — `shipment_id u64`, `actual_delivery i64`,
/// `terminal_code u64`, `nonce u64`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
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

/// SPIKE (CHA-16): prove the ed25519 precompile + instruction-sysvar binding.
///
/// Not a product instruction. It exists so the verification plumbing can be
/// proven in isolation before `settle_policy` is rewired onto it. To be deleted
/// once the real handler carries this check.
#[derive(Accounts)]
pub struct VerifyAttestation<'info> {
    /// CHECK: the instruction sysvar; read to bind the signature to THIS tx.
    #[account(address = INSTRUCTIONS_ID)]
    pub instructions: UncheckedAccount<'info>,
    /// CHECK: the expected attester ed25519 public key (32 raw bytes).
    pub attester: UncheckedAccount<'info>,
}

impl<'info> VerifyAttestation<'info> {
    pub fn verify_attestation(
        &self,
        attestation: DeliveryAttestation,
        signature: [u8; 64],
    ) -> Result<()> {
        verify_ed25519_attestation(
            &self.instructions.to_account_info(),
            &self.attester.key().to_bytes(),
            &attestation.to_message(),
            &signature,
        )
    }
}

/// Verify an ed25519 signature over `message` by `attester_pubkey`, where the
/// signature must have been submitted as an ed25519 precompile instruction
/// *earlier in this same transaction*.
///
/// The sysvar check is the part that matters: the precompile proves a signature
/// is valid, but not that it was made for this transaction. Without binding to
/// the instruction sysvar, any historical signature replays forever.
pub fn verify_ed25519_attestation(
    instructions_sysvar: &AccountInfo,
    attester_pubkey: &[u8; 32],
    message: &[u8; 32],
    signature: &[u8; 64],
) -> Result<()> {
    let current_index =
        load_current_index_checked(instructions_sysvar).map_err(|_| FreightDelayError::AttestationRejected)?;

    // Walk every instruction before this one looking for the precompile call
    // that carries our exact public key, message and signature.
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

/// Ed25519 precompile instruction data layout (15-byte header, then the entries):
///   0..1   num_signatures (u8)
///   1..2   padding
///   2..4   signature_offset (u16, LE)
///   4..6   signature_instruction_index (u16, LE; 0xFFFF = this instruction)
///   6..8   public_key_offset (u16, LE)
///   8..10  public_key_instruction_index (u16, LE)
///   10..12 message_data_offset (u16, LE)
///   12..14 message_data_size (u16, LE)
///   14..15 message_instruction_index (u16 -> actually u8 + padding in practice)
///
/// We only accept the single-signature form whose key/message/signature live
/// inline in this instruction, so the indices must be self-referential.
fn ed25519_ix_matches(data: &[u8], pubkey: &[u8; 32], message: &[u8; 32], signature: &[u8; 64]) -> bool {
    /// `0xFFFF` marks data carried inline in the precompile instruction itself.
    const SELF: u16 = 0xFFFF;
    const HEADER: usize = 16;
    /// Count of signatures, all data inline.
    const COUNT_AND_INLINE_HEADER: usize = 16;

    if data.len() < HEADER || data[0] != 1 {
        return false;
    }
    let read_u16 = |at: usize| u16::from_le_bytes([data[at], data[at + 1]]);

    let sig_off = read_u16(2) as usize;
    let sig_ix = read_u16(4);
    let pk_off = read_u16(6) as usize;
    let pk_ix = read_u16(8);
    let msg_off = read_u16(10) as usize;
    let msg_size = read_u16(12) as usize;
    let msg_ix = data[14];

    if sig_ix != SELF || pk_ix != SELF || msg_ix != 0xFF {
        return false;
    }
    if msg_size != 32 {
        return false;
    }
    let _ = COUNT_AND_INLINE_HEADER;

    let slice = |off: usize, len: usize| -> Option<&[u8]> {
        let end = off.checked_add(len)?;
        data.get(off..end)
    };

    match (
        slice(sig_off, 64),
        slice(pk_off, 32),
        slice(msg_off, 32),
    ) {
        (Some(s), Some(p), Some(m)) => s == signature && p == pubkey && m == message,
        _ => false,
    }
}