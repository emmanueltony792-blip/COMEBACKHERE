#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, vec, Address, Env};

fn setup_env() -> (Env, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TreasuryContract, ());
    (env, contract_id)
}

fn make_client<'a>(env: &'a Env, id: &Address) -> TreasuryContractClient<'a> {
    TreasuryContractClient::new(env, id)
}

#[test]
fn test_update_merchant_and_execute_goes_to_new_address() {
    let (env, contract_id) = setup_env();
    let client = make_client(&env, &contract_id);

    let admin = Address::generate(&env);
    let signer_a = Address::generate(&env);
    let signer_b = Address::generate(&env);
    let token = Address::generate(&env);
    let merchant_a = Address::generate(&env);
    let merchant_b = Address::generate(&env);

    let signers = vec![
        &env,
        (signer_a.clone(), 1u64),
        (signer_b.clone(), 1u64),
    ];
    client.initialize(&signers, &2u64, &admin);

    // Propose settlement with merchant_a as the payout address
    let settlement_id =
        client.propose_settlement(&signer_a, &token, &5_000_000u64, &merchant_a);

    // Verify initial merchant
    let s = client.get_settlement(&settlement_id);
    assert_eq!(s.merchant, merchant_a);

    // Merchant updates their own payout address mid-settlement
    client.update_settlement_merchant(&merchant_a, &settlement_id, &merchant_b);

    // Verify merchant has changed
    let s = client.get_settlement(&settlement_id);
    assert_eq!(
        s.merchant, merchant_b,
        "payout address should be merchant_b after update"
    );

    // Approve and execute
    client.approve_settlement(&signer_a, &settlement_id);
    client.approve_settlement(&signer_b, &settlement_id);
    client.execute_settlement(&signer_a, &settlement_id, &token);

    // Verify execution kept the updated merchant
    let s = client.get_settlement(&settlement_id);
    assert_eq!(s.status, SettlementStatus::Executed);
    assert_eq!(
        s.merchant, merchant_b,
        "executed settlement should keep merchant_b as payout address"
    );

    // Confirm settlement is no longer pending
    let pending = client.get_pending_settlements(&None, &None);
    assert!(!pending.contains(&settlement_id));

    // Verify events were emitted (propose + approve + approve + execute + merchant_updated >= 5)
    let all_events = env.events().all();
    assert!(
        all_events.len() >= 5,
        "expected at least 5 events (including merchant_updated)"
    );
}

#[test]
fn test_update_merchant_non_merchant_returns_unauthorized() {
    let (env, contract_id) = setup_env();
    let client = make_client(&env, &contract_id);

    let admin = Address::generate(&env);
    let signer_a = Address::generate(&env);
    let token = Address::generate(&env);
    let merchant = Address::generate(&env);
    let stranger = Address::generate(&env);
    let new_addr = Address::generate(&env);

    let signers = vec![&env, (signer_a.clone(), 1u64)];
    client.initialize(&signers, &1u64, &admin);

    let settlement_id =
        client.propose_settlement(&signer_a, &token, &1_000_000u64, &merchant);

    // Stranger (not the merchant) attempts to update
    let res = client.try_update_settlement_merchant(
        &stranger,
        &settlement_id,
        &new_addr,
    );
    assert_eq!(res, Err(Ok(TreasuryError::Unauthorized)));
}

#[test]
fn test_update_merchant_on_non_pending_settlement_fails() {
    let (env, contract_id) = setup_env();
    let client = make_client(&env, &contract_id);

    let admin = Address::generate(&env);
    let signer_a = Address::generate(&env);
    let signer_b = Address::generate(&env);
    let token = Address::generate(&env);
    let merchant = Address::generate(&env);
    let new_addr = Address::generate(&env);

    let signers = vec![
        &env,
        (signer_a.clone(), 1u64),
        (signer_b.clone(), 1u64),
    ];
    client.initialize(&signers, &2u64, &admin);

    let settlement_id =
        client.propose_settlement(&signer_a, &token, &1_000_000u64, &merchant);

    // Execute the settlement first
    client.approve_settlement(&signer_a, &settlement_id);
    client.approve_settlement(&signer_b, &settlement_id);
    client.execute_settlement(&signer_a, &settlement_id, &token);

    // Now try to update merchant on an executed settlement
    let res = client.try_update_settlement_merchant(
        &merchant,
        &settlement_id,
        &new_addr,
    );
    assert_eq!(res, Err(Ok(TreasuryError::NotPending)));
}

#[test]
fn test_update_merchant_when_paused_fails() {
    let (env, contract_id) = setup_env();
    let client = make_client(&env, &contract_id);

    let admin = Address::generate(&env);
    let signer_a = Address::generate(&env);
    let token = Address::generate(&env);
    let merchant = Address::generate(&env);
    let new_addr = Address::generate(&env);

    let signers = vec![&env, (signer_a.clone(), 1u64)];
    client.initialize(&signers, &1u64, &admin);

    let settlement_id =
        client.propose_settlement(&signer_a, &token, &1_000_000u64, &merchant);

    client.pause(&admin);

    let res = client.try_update_settlement_merchant(
        &merchant,
        &settlement_id,
        &new_addr,
    );
    assert_eq!(res, Err(Ok(TreasuryError::ContractPaused)));
}
