#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, vec, Address, Env};

fn setup_env() -> (Env, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, TreasuryContract);
    (env, contract_id)
}

fn make_client<'a>(env: &'a Env, id: &Address) -> TreasuryContractClient<'a> {
    TreasuryContractClient::new(env, id)
}

#[test]
fn test_multisig_propose_collect_2_of_3_execute() {
    let (env, contract_id) = setup_env();
    let client = make_client(&env, &contract_id);

    let admin = Address::generate(&env);
    let signer_a = Address::generate(&env);
    let signer_b = Address::generate(&env);
    let signer_c = Address::generate(&env);
    let token = Address::generate(&env);
    let merchant = Address::generate(&env);

    let signers = vec![
        &env,
        (signer_a.clone(), 1u64),
        (signer_b.clone(), 1u64),
        (signer_c.clone(), 1u64),
    ];
    client.initialize(&signers, &2u64, &admin);

    let settlement_id = client.propose_settlement(&signer_a, &token, &5_000_000u64, &merchant);

    let pending_before = client.get_pending_settlements(&None, &None);
    assert_eq!(pending_before.len(), 1);
    assert_eq!(pending_before.get(0).unwrap(), settlement_id);

    client.approve_settlement(&signer_a, &settlement_id);

    let pending_mid = client.get_pending_settlements(&None, &None);
    assert_eq!(
        pending_mid.len(),
        1,
        "settlement should still be pending after 1-of-2 approvals"
    );

    client.approve_settlement(&signer_b, &settlement_id);

    client.execute_settlement(&signer_a, &settlement_id, &token);

    let pending_after = client.get_pending_settlements(&None, &None);
    assert_eq!(
        pending_after.len(),
        0,
        "settlement should no longer be pending after execution"
    );
}

#[test]
fn test_single_signer_insufficient_for_threshold_2() {
    let (env, contract_id) = setup_env();
    let client = make_client(&env, &contract_id);

    let admin = Address::generate(&env);
    let signer_a = Address::generate(&env);
    let signer_b = Address::generate(&env);
    let signer_c = Address::generate(&env);
    let token = Address::generate(&env);
    let merchant = Address::generate(&env);

    let signers = vec![
        &env,
        (signer_a.clone(), 1u64),
        (signer_b.clone(), 1u64),
        (signer_c.clone(), 1u64),
    ];
    client.initialize(&signers, &2u64, &admin);

    let settlement_id = client.propose_settlement(&signer_a, &token, &1_000_000u64, &merchant);
    client.approve_settlement(&signer_a, &settlement_id);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.execute_settlement(&signer_a, &settlement_id, &token);
    }));
    assert!(
        result.is_err(),
        "execution should fail with insufficient approvals"
    );
}

#[test]
fn test_weighted_signers_reach_threshold() {
    let (env, contract_id) = setup_env();
    let client = make_client(&env, &contract_id);

    let admin = Address::generate(&env);
    let signer_a = Address::generate(&env);
    let signer_b = Address::generate(&env);
    let signer_c = Address::generate(&env);
    let token = Address::generate(&env);
    let merchant = Address::generate(&env);

    let signers = vec![
        &env,
        (signer_a.clone(), 2u64),
        (signer_b.clone(), 1u64),
        (signer_c.clone(), 1u64),
    ];
    client.initialize(&signers, &2u64, &admin);

    let settlement_id = client.propose_settlement(&signer_a, &token, &3_000_000u64, &merchant);

    client.approve_settlement(&signer_a, &settlement_id);

    client.execute_settlement(&signer_a, &settlement_id, &token);

    let pending = client.get_pending_settlements(&None, &None);
    assert_eq!(
        pending.len(),
        0,
        "weighted signer with weight=2 should meet threshold=2"
    );
}

#[test]
fn test_multiple_settlements_independent_approvals() {
    let (env, contract_id) = setup_env();
    let client = make_client(&env, &contract_id);

    let admin = Address::generate(&env);
    let signer_a = Address::generate(&env);
    let signer_b = Address::generate(&env);
    let token = Address::generate(&env);
    let merchant = Address::generate(&env);

    let signers = vec![&env, (signer_a.clone(), 1u64), (signer_b.clone(), 1u64)];
    client.initialize(&signers, &2u64, &admin);

    let s1 = client.propose_settlement(&signer_a, &token, &1_000_000u64, &merchant);
    let s2 = client.propose_settlement(&signer_a, &token, &2_000_000u64, &merchant);

    client.approve_settlement(&signer_a, &s1);
    client.approve_settlement(&signer_b, &s1);
    client.execute_settlement(&signer_a, &s1, &token);

    let pending = client.get_pending_settlements(&None, &None);
    assert_eq!(pending.len(), 1, "only s2 should remain pending");
    assert_eq!(pending.get(0).unwrap(), s2);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.execute_settlement(&signer_a, &s2, &token);
    }));
    assert!(
        result.is_err(),
        "s2 should not be executable without approvals"
    );
}

#[test]
fn test_execute_settlement_verifies_token_transfer_setup() {
    let (env, contract_id) = setup_env();
    let client = make_client(&env, &contract_id);

    let admin = Address::generate(&env);
    let signer_a = Address::generate(&env);
    let signer_b = Address::generate(&env);
    let token = Address::generate(&env);
    let merchant = Address::generate(&env);

    let signers = vec![&env, (signer_a.clone(), 1u64), (signer_b.clone(), 1u64)];
    client.initialize(&signers, &2u64, &admin);

    let settlement_id = client.propose_settlement(&signer_a, &token, &10_000_000u64, &merchant);

    client.approve_settlement(&signer_a, &settlement_id);
    client.approve_settlement(&signer_b, &settlement_id);

    client.execute_settlement(&signer_a, &settlement_id, &token);

    let pending = client.get_pending_settlements(&None, &None);
    assert_eq!(
        pending.len(),
        0,
        "executed settlement should no longer appear in pending list"
    );
}

use proptest::prelude::*;
use std::collections::HashSet;
use std::vec::Vec as StdVec;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(50))]

    #[test]
    fn prop_treasury_settlement_quorum_execution(
        weights in prop::collection::vec(1u64..100u64, 1..10),
        threshold in 1u64..500u64,
        approver_indices in prop::collection::vec(0usize..10, 0..10),
    ) {
        let (env, contract_id) = setup_env();
        let client = make_client(&env, &contract_id);

        let admin = Address::generate(&env);
        let token = Address::generate(&env);
        let merchant = Address::generate(&env);

        let mut signers_vec = vec![&env];
        let mut signer_list: StdVec<(Address, u64)> = StdVec::new();

        for &w in &weights {
            let s = Address::generate(&env);
            signers_vec.push_back((s.clone(), w));
            signer_list.push((s, w));
        }

        client.initialize(&signers_vec, &threshold, &admin);
        let proposer = &signer_list[0].0;
        let settlement_id = client.propose_settlement(proposer, &token, &1_000_000u64, &merchant);

        let mut used_indices = HashSet::new();
        let mut accumulated_weight = 0u64;

        for &raw_idx in &approver_indices {
            let idx = raw_idx % signer_list.len();
            if used_indices.insert(idx) {
                let (ref signer_addr, weight) = signer_list[idx];
                client.approve_settlement(signer_addr, &settlement_id);
                accumulated_weight += weight;
            }
        }

        let exec_res = client.try_execute_settlement(proposer, &settlement_id, &token);

        if accumulated_weight >= threshold {
            prop_assert_eq!(exec_res, Ok(Ok(())));
            let pending = client.get_pending_settlements(&None, &None);
            prop_assert_eq!(pending.len(), 0);
        } else {
            prop_assert_eq!(exec_res, Err(Ok(TreasuryError::InsufficientApprovals)));
            let pending = client.get_pending_settlements(&None, &None);
            prop_assert_eq!(pending.len(), 1);
        }
    }
}
