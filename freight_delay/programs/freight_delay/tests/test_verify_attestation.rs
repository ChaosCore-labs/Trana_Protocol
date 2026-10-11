//! SPIKE (CHA-16): prove the ed25519 precompile + instruction-sysvar binding.
//!
//! The point of this test is the *binding*, not ed25519 itself. The precompile
//! proves a signature is valid; only the instruction sysvar proves it was made
//! for THIS transaction. Without it, any historical signature replays forever.
//!
//! Delete this file when `settle_policy` carries the check and its own tests
//! cover the same ground.

#![allow(clippy::result_large_err)]

use anchor_lang::{
    InstructionData, ToAccountMetas, pubkey,
    solana_program::instruction::Instruction,
};
use freight_delay::{accounts, instruction};
use litesvm::{LiteSVM, types::TransactionResult};
use solana_awesome::{
    keypair::Keypair, message::{Message, VersionedMessage}, pubkey::Pubkey, signer::Signer,
    transaction::versioned::VersionedTransaction,
};

use freight_delay::instructions::verify_attestation::DeliveryAttestation;

const SHIPMENT_ID: u64 = 42;
const ACTUAL_DELIVERY: i64 = 1_760_000_000;
const TERMINAL_CODE: u64 = 1101;
const NONCE: u64 = 7;

fn attester_program() -> Pubkey {
    freight_delay::id()
}

/// Build a native ed25519 precompile instruction carrying one inline signature.
///
/// Layout (16-byte header + entries), per the precompile spec:
///   [0]      num_signatures = 1
///   [1]      padding
///   [2..4]   signature_offset       (u16 LE, into this same data)
///   [4..6]   signature_ix_index     (0xFFFF = this instruction)
///   [6..8]   public_key_offset      (u16 LE)
///   [8..10]  public_key_ix_index    (0xFFFF)
///   [10..12] message_offset         (u16 LE)
///   [12..14] message_size           (u16 LE)
///   [14..16] message_ix_index       (0xFFFF)
///   [16..]   pubkey(32) | signature(64) | message(32)
fn ed25519_precompile_ix(pubkey: &[u8; 32], signature: &[u8; 64], message: &[u8; 32]) -> Instruction {
    const SELF: u16 = 0xFFFF;
    let mut data = Vec::with_capacity(16 + 32 + 64 + 32);
    data.push(1); // num_signatures
    data.push(0); // padding

    let pk_off = 16u16;
    let sig_off = pk_off + 32;
    let msg_off = sig_off + 64;

    data.extend_from_slice(&sig_off.to_le_bytes());
    data.extend_from_slice(&SELF.to_le_bytes());
    data.extend_from_slice(&pk_off.to_le_bytes());
    data.extend_from_slice(&SELF.to_le_bytes());
    data.extend_from_slice(&msg_off.to_le_bytes());
    data.extend_from_slice(&32u16.to_le_bytes());
    data.extend_from_slice(&SELF.to_le_bytes());

    data.extend_from_slice(pubkey);
    data.extend_from_slice(signature);
    data.extend_from_slice(message);

    Instruction {
        program_id: pubkey!("Ed25519SigVerify111111111111111111111111111"),
        accounts: vec![],
        data,
    }
}

fn attestation() -> DeliveryAttestation {
    DeliveryAttestation {
        shipment_id: SHIPMENT_ID,
        actual_delivery: ACTUAL_DELIVERY,
        terminal_code: TERMINAL_CODE,
        nonce: NONCE,
    }
}

/// The message the attester signs: the 32-byte LE encoding of the attestation.
fn message(att: &DeliveryAttestation) -> [u8; 32] {
    let mut buf = [0u8; 32];
    buf[0..8].copy_from_slice(&att.shipment_id.to_le_bytes());
    buf[8..16].copy_from_slice(&att.actual_delivery.to_le_bytes());
    buf[16..24].copy_from_slice(&att.terminal_code.to_le_bytes());
    buf[24..32].copy_from_slice(&att.nonce.to_le_bytes());
    buf
}

fn setup() -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new().with_precompiles();
    let bytes = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/deploy/freight_delay.so"
    ));
    svm.add_program(attester_program(), bytes).unwrap();

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
    (svm, payer)
}

fn send(svm: &mut LiteSVM, payer: &Keypair, ixs: &[Instruction]) -> TransactionResult {
    svm.expire_blockhash();
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[payer]).unwrap();
    svm.send_transaction(tx)
}

fn verify_ix(attester: &Pubkey, att: &DeliveryAttestation, sig: [u8; 64]) -> Instruction {
    Instruction::new_with_bytes(
        attester_program(),
        &instruction::VerifyAttestation {
            attestation: att.clone(),
            signature: sig,
        }
        .data(),
        accounts::VerifyAttestation {
            instructions: solana_instructions_sysvar::ID,
            attester: *attester,
        }
        .to_account_metas(None),
    )
}

fn sign(keypair: &Keypair, msg: &[u8; 32]) -> [u8; 64] {
    // The attester is a plain ed25519 key; its `Pubkey` is the raw 32 bytes.
    keypair.sign_message(msg).as_ref().try_into().unwrap()
}

#[test]
fn accepts_signature_included_in_the_same_transaction() {
    let (mut svm, payer) = setup();
    let attester = Keypair::new();
    let att = attestation();
    let msg = message(&att);
    let sig = sign(&attester, &msg);

    let ixs = [
        ed25519_precompile_ix(&attester.pubkey().to_bytes(), &sig, &msg),
        verify_ix(&attester.pubkey(), &att, sig),
    ];
    let res = send(&mut svm, &payer, &ixs);
    assert!(res.is_ok(), "valid attestation should verify: {res:?}");
}

#[test]
fn rejects_when_the_precompile_instruction_is_absent() {
    // The signature is real and valid, but never submitted to the precompile.
    // The sysvar scan must find nothing and reject.
    let (mut svm, payer) = setup();
    let attester = Keypair::new();
    let att = attestation();
    let msg = message(&att);
    let sig = sign(&attester, &msg);

    let res = send(&mut svm, &payer, &[verify_ix(&attester.pubkey(), &att, sig)]);
    assert!(res.is_err(), "attestation without a precompile instruction must fail");
}

#[test]
fn rejects_a_tampered_payload() {
    let (mut svm, payer) = setup();
    let attester = Keypair::new();
    let att = attestation();
    let msg = message(&att);
    let sig = sign(&attester, &msg);

    // Same signature, but the handler is handed a different nonce. The
    // precompile entry still matches the ORIGINAL message, so the sysvar scan
    // cannot find an entry for the tampered one.
    let tampered = DeliveryAttestation { nonce: NONCE + 1, ..att };
    let ixs = [
        ed25519_precompile_ix(&attester.pubkey().to_bytes(), &sig, &msg),
        verify_ix(&attester.pubkey(), &tampered, sig),
    ];
    let res = send(&mut svm, &payer, &ixs);
    assert!(res.is_err(), "a signature over different bytes must not verify");
}

#[test]
fn rejects_a_signature_from_the_wrong_attester() {
    let (mut svm, payer) = setup();
    let real = Keypair::new();
    let impostor = Keypair::new();
    let att = attestation();
    let msg = message(&att);
    let sig = sign(&real, &msg);

    // Precompile carries the impostor's key, so the entry never matches the
    // configured attester.
    let ixs = [
        ed25519_precompile_ix(&impostor.pubkey().to_bytes(), &sig, &msg),
        verify_ix(&real.pubkey(), &att, sig),
    ];
    let res = send(&mut svm, &payer, &ixs);
    assert!(res.is_err(), "a signature from another key must not verify");
}
