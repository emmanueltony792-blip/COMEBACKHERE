#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, vec, Address, Env};

fn setup_bench_env() -> (Env, Address, TreasuryContractClient) {
    let e = Env::default();
    e.mock_all_auths();
    let contract_id = e.register(TreasuryContract, ());
    let client = TreasuryContractClient::new(&e, &contract_id);

    let admin = Address::generate(&e);
    let signer = Address::generate(&e);
    client.initialize(&vec![&e, (signer.clone(), 1u64)], &1, &admin);

    (e, contract_id, client)
}

#[test]
fn bench_propose_settlement() {
    let (e, _id, client) = setup_bench_env();
    let signer = Address::generate(&e);
    let token = Address::generate(&e);
    let merchant = Address::generate(&e);

    e.budget().reset_unlimited();
    let cpu_before = e.budget().get_cpu_instructions_used();
    let mem_before = e.budget().get_memory_bytes_used();

    let sid = client.propose_settlement(&signer, &token, &5_000_000u64, &merchant);

    let cpu_after = e.budget().get_cpu_instructions_used();
    let mem_after = e.budget().get_memory_bytes_used();

    let cpu_delta = cpu_after - cpu_before;
    let mem_delta = mem_after - mem_before;

    let pending = client.get_pending_settlements(&None, &None);
    assert!(pending.contains(&sid), "settlement should be pending");

    assert!(
        cpu_delta < 5_000_000,
        "CPU instructions ({cpu_delta}) exceeded expected threshold"
    );
    assert!(
        mem_delta < 500_000,
        "Memory bytes ({mem_delta}) exceeded expected threshold"
    );
}

#[test]
fn bench_propose_settlement_deterministic() {
    let (e, _id, client) = setup_bench_env();
    let signer = Address::generate(&e);
    let token = Address::generate(&e);
    let merchant = Address::generate(&e);

    e.budget().reset_unlimited();
    let cpu1_before = e.budget().get_cpu_instructions_used();
    client.propose_settlement(&signer, &token, &5_000_000u64, &merchant);
    let cpu1_after = e.budget().get_cpu_instructions_used();
    let cpu1 = cpu1_after - cpu1_before;

    let signer2 = Address::generate(&e);
    e.budget().reset_unlimited();
    let cpu2_before = e.budget().get_cpu_instructions_used();
    client.propose_settlement(&signer2, &token, &5_000_000u64, &merchant);
    let cpu2_after = e.budget().get_cpu_instructions_used();
    let cpu2 = cpu2_after - cpu2_before;

    assert_eq!(
        cpu1, cpu2,
        "propose_settlement CPU cost should be deterministic"
    );
}
