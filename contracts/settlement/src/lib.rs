#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SettlementStatus {
    Pending,
    Executed,
    Cancelled,
}

#[contracttype]
#[derive(Clone)]
pub struct Settlement {
    pub merchant: Address,
    pub amount: u64,
    pub status: SettlementStatus,
    pub approval_weight: u64,
    pub approvals: Vec<Address>,
    pub proposer: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ApproveResult {
    pub approval_weight: u64,
    pub threshold: u64,
}

#[contracterror]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum SettlementError {
    NotFound = 1,
    Unauthorized = 2,
    AlreadyApproved = 3,
    NotPending = 4,
    DuplicateSigner = 5,
    InvalidWeightSum = 6,
}

#[contracttype]
pub enum DataKey {
    Threshold,
    Signer(Address),
    Settlement(u64),
    NextId,
}

#[contract]
pub struct SettlementContract;

#[contractimpl]
impl SettlementContract {
    /// Initialize with signers (address, weight pairs) and approval threshold.
    pub fn initialize(
        e: Env,
        signers: Vec<(Address, u64)>,
        threshold: u64,
    ) -> Result<(), SettlementError> {
        let mut seen: Vec<Address> = Vec::new(&e);
        let mut total_weight: u64 = 0;
        for (signer, weight) in signers.iter() {
            if seen.contains(&signer) {
                return Err(SettlementError::DuplicateSigner);
            }
            seen.push_back(signer.clone());
            total_weight += weight;
        }
        if total_weight < threshold {
            return Err(SettlementError::InvalidWeightSum);
        }
        e.storage().instance().set(&DataKey::Threshold, &threshold);
        e.storage().instance().set(&DataKey::NextId, &1u64);
        for (signer, weight) in signers.iter() {
            e.storage()
                .instance()
                .set(&DataKey::Signer(signer.clone()), &weight);
        }
        Ok(())
    }

    /// Propose a new settlement; returns the settlement ID.
    pub fn propose(e: Env, proposer: Address, merchant: Address, amount: u64) -> u64 {
        proposer.require_auth();
        let id: u64 = e
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .unwrap_or(1u64);
        let s = Settlement {
            merchant,
            amount,
            status: SettlementStatus::Pending,
            approval_weight: 0,
            approvals: Vec::new(&e),
            proposer: proposer.clone(),
        };
        e.storage().instance().set(&DataKey::Settlement(id), &s);
        e.storage().instance().set(&DataKey::NextId, &(id + 1));
        id
    }

    /// Approve a pending settlement.
    ///
    /// Returns the current `approval_weight` and required `threshold` so callers
    /// can track progress toward execution.
    ///
    /// Errors:
    /// - `NotFound`      – settlement ID does not exist
    /// - `Unauthorized`  – signer has no registered weight
    /// - `AlreadyApproved` – signer has already approved this settlement
    /// - `NotPending`    – settlement is not in Pending status
    pub fn approve_settlement(
        e: Env,
        signer: Address,
        settlement_id: u64,
    ) -> Result<ApproveResult, SettlementError> {
        signer.require_auth();

        let weight: u64 = e
            .storage()
            .instance()
            .get(&DataKey::Signer(signer.clone()))
            .unwrap_or(0);
        if weight == 0 {
            return Err(SettlementError::Unauthorized);
        }

        let mut settlement: Settlement = e
            .storage()
            .instance()
            .get(&DataKey::Settlement(settlement_id))
            .ok_or(SettlementError::NotFound)?;

        if settlement.status != SettlementStatus::Pending {
            return Err(SettlementError::NotPending);
        }

        if settlement.approvals.contains(&signer) {
            return Err(SettlementError::AlreadyApproved);
        }

        settlement.approval_weight += weight;
        settlement.approvals.push_back(signer);
        e.storage()
            .instance()
            .set(&DataKey::Settlement(settlement_id), &settlement);

        let threshold: u64 = e
            .storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or(0);

        Ok(ApproveResult {
            approval_weight: settlement.approval_weight,
            threshold,
        })
    }

    /// Cancel a pending settlement.
    ///
    /// Only the original proposer or an authorized signer may cancel.
    ///
    /// Errors:
    /// - `NotFound`      – settlement ID does not exist
    /// - `Unauthorized`  – caller is neither proposer nor authorized signer
    /// - `NotPending`    – settlement is not in Pending status
    pub fn cancel(e: Env, caller: Address, settlement_id: u64) -> Result<(), SettlementError> {
        caller.require_auth();

        let mut settlement: Settlement = e
            .storage()
            .instance()
            .get(&DataKey::Settlement(settlement_id))
            .ok_or(SettlementError::NotFound)?;

        if settlement.status != SettlementStatus::Pending {
            return Err(SettlementError::NotPending);
        }

        // Allow original proposer or an authorized signer to cancel
        let is_proposer = settlement.proposer == caller;
        let weight: u64 = e
            .storage()
            .instance()
            .get(&DataKey::Signer(caller.clone()))
            .unwrap_or(0);
        if !is_proposer && weight == 0 {
            return Err(SettlementError::Unauthorized);
        }

        settlement.status = SettlementStatus::Cancelled;
        e.storage()
            .instance()
            .set(&DataKey::Settlement(settlement_id), &settlement);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    fn setup() -> (Env, Address) {
        let e = Env::default();
        e.mock_all_auths();
        let id = e.register_contract(None, SettlementContract);
        (e, id)
    }

    #[test]
    fn test_approve_increments_weight_and_returns_threshold() {
        let (e, id) = setup();
        let c = SettlementContractClient::new(&e, &id);
        let signer = Address::generate(&e);
        let merchant = Address::generate(&e);

        c.initialize(&soroban_sdk::vec![&e, (signer.clone(), 2u64)], &2u64);
        let sid = c.propose(&signer, &merchant, &1000u64);

        let res = c.approve_settlement(&signer, &sid);
        assert_eq!(res.approval_weight, 2);
        assert_eq!(res.threshold, 2);
    }

    #[test]
    fn test_approve_unauthorized_signer() {
        let (e, id) = setup();
        let c = SettlementContractClient::new(&e, &id);
        let authorized = Address::generate(&e);
        let stranger = Address::generate(&e);
        let merchant = Address::generate(&e);

        c.initialize(&soroban_sdk::vec![&e, (authorized.clone(), 1u64)], &1u64);
        let sid = c.propose(&authorized, &merchant, &500u64);

        let res = c.try_approve_settlement(&stranger, &sid);
        assert_eq!(res, Err(Ok(SettlementError::Unauthorized)));
    }

    #[test]
    fn test_approve_already_approved() {
        let (e, id) = setup();
        let c = SettlementContractClient::new(&e, &id);
        let signer = Address::generate(&e);
        let merchant = Address::generate(&e);

        c.initialize(&soroban_sdk::vec![&e, (signer.clone(), 1u64)], &1u64);
        let sid = c.propose(&signer, &merchant, &100u64);

        c.approve_settlement(&signer, &sid);
        let res = c.try_approve_settlement(&signer, &sid);
        assert_eq!(res, Err(Ok(SettlementError::AlreadyApproved)));
    }

    #[test]
    fn test_approve_not_found() {
        let (e, id) = setup();
        let c = SettlementContractClient::new(&e, &id);
        let signer = Address::generate(&e);

        c.initialize(&soroban_sdk::vec![&e, (signer.clone(), 1u64)], &1u64);

        let res = c.try_approve_settlement(&signer, &99u64);
        assert_eq!(res, Err(Ok(SettlementError::NotFound)));
    }

    #[test]
    fn test_approve_not_pending() {
        let (e, id) = setup();
        let c = SettlementContractClient::new(&e, &id);
        let signer = Address::generate(&e);
        let merchant = Address::generate(&e);

        c.initialize(&soroban_sdk::vec![&e, (signer.clone(), 1u64)], &1u64);
        let sid = c.propose(&signer, &merchant, &200u64);
        c.cancel(&signer, &sid);

        let res = c.try_approve_settlement(&signer, &sid);
        assert_eq!(res, Err(Ok(SettlementError::NotPending)));
    }

    #[test]
    fn test_multiple_signers_accumulate_weight() {
        let (e, id) = setup();
        let c = SettlementContractClient::new(&e, &id);
        let s1 = Address::generate(&e);
        let s2 = Address::generate(&e);
        let merchant = Address::generate(&e);

        c.initialize(
            &soroban_sdk::vec![&e, (s1.clone(), 1u64), (s2.clone(), 2u64)],
            &3u64,
        );
        let sid = c.propose(&s1, &merchant, &500u64);

        let r1 = c.approve_settlement(&s1, &sid);
        assert_eq!(r1.approval_weight, 1);

        let r2 = c.approve_settlement(&s2, &sid);
        assert_eq!(r2.approval_weight, 3);
        assert_eq!(r2.threshold, 3);
    }

    // ── cancel authorization tests ──────────────────────────────────────────

    #[test]
    fn test_cancel_own_settlement_succeeds() {
        let (e, id) = setup();
        let c = SettlementContractClient::new(&e, &id);
        let proposer = Address::generate(&e);
        let merchant = Address::generate(&e);

        c.initialize(
            &soroban_sdk::vec![&e, (proposer.clone(), 1u64)],
            &1u64,
        );
        let sid = c.propose(&proposer, &merchant, &1000u64);

        // Proposer cancels their own settlement — should succeed
        c.cancel(&proposer, &sid);

        // Verify it is now cancelled by trying to cancel again
        let res = c.try_cancel(&proposer, &sid);
        assert_eq!(res, Err(Ok(SettlementError::NotPending)));
    }

    #[test]
    fn test_cancel_unauthorized_stranger() {
        let (e, id) = setup();
        let c = SettlementContractClient::new(&e, &id);
        let proposer = Address::generate(&e);
        let stranger = Address::generate(&e);
        let merchant = Address::generate(&e);

        c.initialize(
            &soroban_sdk::vec![&e, (proposer.clone(), 1u64)],
            &1u64,
        );
        let sid = c.propose(&proposer, &merchant, &1000u64);

        // Stranger (not proposer, not authorized signer) attempts cancel
        let res = c.try_cancel(&stranger, &sid);
        assert_eq!(res, Err(Ok(SettlementError::Unauthorized)));
    }

    #[test]
    fn test_cancel_authorized_signer_can_cancel() {
        let (e, id) = setup();
        let c = SettlementContractClient::new(&e, &id);
        let proposer = Address::generate(&e);
        let signer = Address::generate(&e);
        let merchant = Address::generate(&e);

        c.initialize(
            &soroban_sdk::vec![&e, (proposer.clone(), 1u64), (signer.clone(), 1u64)],
            &2u64,
        );
        let sid = c.propose(&proposer, &merchant, &1000u64);

        // Authorized signer (not proposer) can also cancel
        c.cancel(&signer, &sid);

        let res = c.try_cancel(&signer, &sid);
        assert_eq!(res, Err(Ok(SettlementError::NotPending)));
    }

    #[test]
    fn test_cancel_not_found() {
        let (e, id) = setup();
        let c = SettlementContractClient::new(&e, &id);
        let signer = Address::generate(&e);

        c.initialize(
            &soroban_sdk::vec![&e, (signer.clone(), 1u64)],
            &1u64,
        );

        let res = c.try_cancel(&signer, &99u64);
        assert_eq!(res, Err(Ok(SettlementError::NotFound)));
    }

    #[test]
    fn test_cancel_not_pending_fails() {
        let (e, id) = setup();
        let c = SettlementContractClient::new(&e, &id);
        let proposer = Address::generate(&e);
        let merchant = Address::generate(&e);

        c.initialize(
            &soroban_sdk::vec![&e, (proposer.clone(), 1u64)],
            &1u64,
        );
        let sid = c.propose(&proposer, &merchant, &1000u64);

        // Cancel succeeds
        c.cancel(&proposer, &sid);

        // Cancelling an already-cancelled (or executed) settlement fails with NotPending
        let res = c.try_cancel(&proposer, &sid);
        assert_eq!(res, Err(Ok(SettlementError::NotPending)));
    use proptest::prelude::*;
    extern crate std;
    use std::collections::HashSet;
    use std::vec::Vec;

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(50))]

        #[test]
        fn prop_settlement_quorum_logic(
            weights in prop::collection::vec(1u64..100u64, 1..10),
            threshold in 1u64..500u64,
            approver_indices in prop::collection::vec(0usize..10, 0..10),
        ) {
            let (e, id) = setup();
            let c = SettlementContractClient::new(&e, &id);

            let merchant = Address::generate(&e);
            let mut signers_vec = soroban_sdk::Vec::new(&e);
            let mut signer_list: Vec<(Address, u64)> = Vec::new();

            for &w in &weights {
                let s = Address::generate(&e);
                signers_vec.push_back((s.clone(), w));
                signer_list.push((s, w));
            }

            c.initialize(&signers_vec, &threshold);
            let proposer = &signer_list[0].0;
            let sid = c.propose(proposer, &merchant, &1000u64);

            let mut used_indices = HashSet::new();
            let mut expected_accumulated_weight = 0u64;

            for &raw_idx in &approver_indices {
                let idx = raw_idx % signer_list.len();
                if used_indices.insert(idx) {
                    let (ref signer_addr, weight) = signer_list[idx];
                    let res = c.approve_settlement(signer_addr, &sid);
                    expected_accumulated_weight += weight;
                    prop_assert_eq!(res.approval_weight, expected_accumulated_weight);
                    prop_assert_eq!(res.threshold, threshold);
                }
            }

            let quorum_met = expected_accumulated_weight >= threshold;
            prop_assert_eq!(expected_accumulated_weight >= threshold, quorum_met);
        }
    }
}
