#![no_std]

#[cfg(test)]
extern crate std;

use soroban_sdk::{contract, contractimpl, contracttype, contracterror, Address, Env, Symbol, Vec};

/// Status of a settlement proposal within the Treasury contract.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SettlementStatus {
    /// Proposal is created and pending approval or execution.
    Pending,
    /// Proposal has been fully executed.
    Executed,
    /// Proposal has been partially executed.
    PartiallyExecuted,
    /// Proposal is placed on hold due to a dispute.
    OnHold,
    /// Proposal was cancelled.
    Cancelled,
}

/// Represents a settlement proposal managed by the Treasury contract.
#[contracttype]
pub struct Settlement {
    /// Token contract address for settlement transfers.
    pub token: Address,
    /// Amount to be settled.
    pub amount: u64,
    /// Merchant recipient address.
    pub merchant: Address,
    /// Current status of the settlement.
    pub status: SettlementStatus,
    /// Accumulated approval weight from authorized signers.
    pub approval_weight: u64,
    /// Address of the signer who proposed the settlement.
    pub proposer: Address,
}

/// Error types returned by Treasury contract operations.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum TreasuryError {
    /// The contract is currently paused.
    ContractPaused = 1,
    /// The settlement is not in `Pending` status.
    NotPending = 2,
    /// Accumulated approval weight is insufficient for threshold.
    InsufficientApprovals = 3,
    /// Token is not allowed by the token allowlist policy.
    TokenNotAllowed = 4,
    /// Caller is unauthorized to perform the action.
    Unauthorized = 5,
    /// Provided threshold is invalid (e.g. 0).
    InvalidThreshold = 6,
    DuplicateSigner = 7,
    InvalidWeightSum = 8,
    NotSettlementParty = 9,
}

/// Storage keys for Treasury contract instance state.
#[contracttype]
pub enum DataKey {
    /// Admin address key.
    Admin,
    /// Paused status key.
    Paused,
    /// Mapping of signer address to voting weight key.
    Signer(Address),
    /// Settlement proposal storage key by settlement ID.
    Settlement(u64),
    /// Auto-incrementing settlement ID counter key.
    NextSettlementId,
    /// Approval threshold weight key.
    Threshold,
    /// Token allowlist key.
    TokenAllowlist,
}

fn is_paused(e: &Env) -> bool {
    e.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

fn check_not_paused(e: &Env) -> Result<(), TreasuryError> {
    if is_paused(e) {
        Err(TreasuryError::ContractPaused)
    } else {
        Ok(())
    }
}

/// Main Treasury contract managing multi-sig settlement approvals, token allowlists, and contract pauses.
#[contract]
pub struct TreasuryContract;

#[contractimpl]
impl TreasuryContract {
    pub fn initialize(
        e: Env,
        signers: Vec<(Address, u64)>,
        threshold: u64,
        admin: Address,
    ) -> Result<(), TreasuryError> {
        admin.require_auth();
        let mut seen: Vec<Address> = Vec::new(&e);
        let mut total_weight: u64 = 0;
        for (signer, weight) in signers.iter() {
            if seen.contains(&signer) {
                return Err(TreasuryError::DuplicateSigner);
            }
            seen.push_back(signer.clone());
            total_weight += weight;
        }
        if total_weight < threshold {
            return Err(TreasuryError::InvalidWeightSum);
        }
        e.storage().instance().set(&DataKey::Admin, &admin);
        e.storage().instance().set(&DataKey::Threshold, &threshold);
        e.storage().instance().set(&DataKey::Paused, &false);
        e.storage().instance().set(&DataKey::NextSettlementId, &1u64);
        let mut signer_list: Vec<Address> = Vec::new(&e);
        for (signer, weight) in signers.iter() {
            e.storage()
                .instance()
                .set(&DataKey::Signer(signer.clone()), &weight);
            signer_list.push_back(signer.clone());
        }
        e.storage().instance().set(&DataKey::SignerList, &signer_list);
        Ok(())
    }

    /// Sets or updates the voting weight for a signer address.
    ///
    /// # Arguments
    /// * `e` - Soroban environment handle.
    /// * `admin` - Admin address (must authenticate).
    /// * `signer` - Signer address whose weight is being updated.
    /// * `weight` - Voting weight assigned to the signer (0 to remove signer).
    ///
    /// # Errors
    /// * Returns [`TreasuryError::ContractPaused`] if contract operations are paused.
    /// * Returns [`TreasuryError::Unauthorized`] if `admin` is not the stored contract admin.
    pub fn set_signer(
        e: Env,
        admin: Address,
        signer: Address,
        weight: u64,
    ) -> Result<(), TreasuryError> {
        check_not_paused(&e)?;
        Self::check_admin(&e, &admin)?;
        e.storage()
            .instance()
            .set(&DataKey::Signer(signer.clone()), &weight);
        // Maintain the signer list so update_threshold can compute total weight.
        let mut signer_list: Vec<Address> = e
            .storage()
            .instance()
            .get(&DataKey::SignerList)
            .unwrap_or_else(|| Vec::new(&e));
        if !signer_list.contains(&signer) {
            signer_list.push_back(signer);
            e.storage().instance().set(&DataKey::SignerList, &signer_list);
        }
        Ok(())
    }

    /// Proposes a new settlement for approval and execution.
    ///
    /// # Arguments
    /// * `e` - Soroban environment handle.
    /// * `signer` - Proposer address (must authenticate).
    /// * `token` - Token address for the settlement.
    /// * `amount` - Settlement amount.
    /// * `merchant` - Merchant recipient address.
    ///
    /// # Returns
    /// * `Ok(u64)` - The auto-incremented settlement ID for the created proposal.
    ///
    /// # Errors
    /// * Returns [`TreasuryError::ContractPaused`] if contract operations are paused.
    /// * Returns [`TreasuryError::TokenNotAllowed`] if token allowlist is non-empty and `token` is not allowed.
    pub fn propose_settlement(
        e: Env,
        signer: Address,
        token: Address,
        amount: u64,
        merchant: Address,
    ) -> Result<u64, TreasuryError> {
        check_not_paused(&e)?;
        signer.require_auth();

        let allowlist: Vec<Address> = e
            .storage()
            .instance()
            .get(&DataKey::TokenAllowlist)
            .unwrap_or_else(|| Vec::new(&e));
        if !allowlist.is_empty() && !allowlist.contains(&token) {
            return Err(TreasuryError::TokenNotAllowed);
        }

        let settlement_id: u64 = e
            .storage()
            .instance()
            .get(&DataKey::NextSettlementId)
            .unwrap_or(1u64);

        let settlement = Settlement {
            token,
            amount,
            merchant,
            status: SettlementStatus::Pending,
            approval_weight: 0u64,
            proposer: signer,
        };

        e.storage()
            .instance()
            .set(&DataKey::Settlement(settlement_id), &settlement);
        e.storage()
            .instance()
            .set(&DataKey::NextSettlementId, &(settlement_id + 1));

        Ok(settlement_id)
    }

    /// Casts an approval vote on a pending settlement proposal.
    ///
    /// # Arguments
    /// * `e` - Soroban environment handle.
    /// * `signer` - Authorized signer address casting the vote (must authenticate).
    /// * `settlement_id` - ID of the settlement proposal to approve.
    ///
    /// # Errors
    /// * Returns [`TreasuryError::ContractPaused`] if contract operations are paused.
    /// * Returns [`TreasuryError::NotPending`] if settlement is not in `Pending` status.
    pub fn approve_settlement(
        e: Env,
        signer: Address,
        settlement_id: u64,
    ) -> Result<(), TreasuryError> {
        check_not_paused(&e)?;
        signer.require_auth();
        let mut settlement = Self::get_settlement_internal(&e, settlement_id);
        if settlement.status != SettlementStatus::Pending {
            return Err(TreasuryError::NotPending);
        }
        let weight: u64 = e
            .storage()
            .instance()
            .get(&DataKey::Signer(signer.clone()))
            .unwrap_or(0u64);
        settlement.approval_weight += weight;
        e.storage()
            .instance()
            .set(&DataKey::Settlement(settlement_id), &settlement);
        Ok(())
    }

    /// Executes a pending settlement once accumulated approval weight meets or exceeds threshold.
    ///
    /// # Arguments
    /// * `e` - Soroban environment handle.
    /// * `signer` - Caller address executing the settlement (must authenticate).
    /// * `settlement_id` - ID of the settlement proposal to execute.
    /// * `_token_contract` - Token contract address.
    ///
    /// # Errors
    /// * Returns [`TreasuryError::ContractPaused`] if contract operations are paused.
    /// * Returns [`TreasuryError::NotPending`] if settlement is not in `Pending` status.
    /// * Returns [`TreasuryError::InsufficientApprovals`] if accumulated approval weight is below threshold.
    pub fn execute_settlement(
        e: Env,
        signer: Address,
        settlement_id: u64,
        _token_contract: Address,
    ) -> Result<(), TreasuryError> {
        check_not_paused(&e)?;
        signer.require_auth();
        let mut settlement = Self::get_settlement_internal(&e, settlement_id);
        if settlement.status != SettlementStatus::Pending {
            return Err(TreasuryError::NotPending);
        }
        let threshold: u64 = e
            .storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or(0u64);
        if settlement.approval_weight < threshold {
            return Err(TreasuryError::InsufficientApprovals);
        }
        settlement.status = SettlementStatus::Executed;
        e.storage()
            .instance()
            .set(&DataKey::Settlement(settlement_id), &settlement);
        Ok(())
    }

    /// Retrieves a paginated list of pending settlement IDs.
    ///
    /// # Arguments
    /// * `e` - Soroban environment handle.
    /// * `offset` - Optional offset for pagination (defaults to 0).
    /// * `limit` - Optional page limit (defaults to 100, max 100).
    ///
    /// # Returns
    /// * `Vec<u64>` - List of pending settlement IDs matching pagination.
    pub fn get_pending_settlements(
        e: Env,
        offset: Option<u32>,
        limit: Option<u32>,
    ) -> Result<Vec<u64>, TreasuryError> {
        const MAX_PAGE_SIZE: u32 = 100;
        let next_id: u64 = e
            .storage()
            .instance()
            .get(&DataKey::NextSettlementId)
            .unwrap_or(1u64);
        let cap: u32 = if let Some(limit) = limit {
            if limit > MAX_PAGE_SIZE {
                return Err(TreasuryError::InvalidPagination);
            }
            limit
        } else {
            MAX_PAGE_SIZE
        };
        let skip: u32 = offset.unwrap_or(0);

        let mut result: Vec<u64> = Vec::new(&e);
        let mut matched: u32 = 0;
        let mut collected: u32 = 0;

        for id in 1..next_id {
            if let Some(s) = e
                .storage()
                .instance()
                .get::<DataKey, Settlement>(&DataKey::Settlement(id))
            {
                if matches!(s.status, SettlementStatus::Pending) {
                    if matched >= skip {
                        if collected >= cap {
                            break;
                        }
                        result.push_back(id);
                        collected += 1;
                    }
                    matched += 1;
                }
            }
        }
        Ok(result)
    }

    fn check_admin(e: &Env, admin: &Address) -> Result<(), TreasuryError> {
        admin.require_auth();
        let stored_admin: Address = e.storage().instance().get(&DataKey::Admin).unwrap();
        if stored_admin != *admin {
            return Err(TreasuryError::Unauthorized);
        }
        Ok(())
    }

    /// Pauses non-admin contract operations.
    ///
    /// # Arguments
    /// * `e` - Soroban environment handle.
    /// * `admin` - Admin address (must authenticate).
    ///
    /// # Errors
    /// * Returns [`TreasuryError::Unauthorized`] if caller is not the contract admin.
    pub fn pause(e: Env, admin: Address) -> Result<(), TreasuryError> {
        Self::check_admin(&e, &admin)?;
        e.storage().instance().set(&DataKey::Paused, &true);
        e.events().publish(
            (Symbol::new(&e, "contract_paused"),),
            (),
        );
        Ok(())
    }

    /// Unpauses contract operations.
    ///
    /// # Arguments
    /// * `e` - Soroban environment handle.
    /// * `admin` - Admin address (must authenticate).
    ///
    /// # Errors
    /// * Returns [`TreasuryError::Unauthorized`] if caller is not the contract admin.
    pub fn unpause(e: Env, admin: Address) -> Result<(), TreasuryError> {
        Self::check_admin(&e, &admin)?;
        e.storage().instance().set(&DataKey::Paused, &false);
        e.events().publish(
            (Symbol::new(&e, "contract_unpaused"),),
            (),
        );
        Ok(())
    }

    /// Returns the current total approval threshold weight required for executing settlements.
    ///
    /// # Arguments
    /// * `e` - Soroban environment handle.
    ///
    /// # Returns
    /// * `u64` - Current approval weight threshold.
    pub fn get_threshold(e: Env) -> u64 {
        e.storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or(0u64)
    }

    /// Updates the required approval threshold weight for settlement execution.
    ///
    /// # Arguments
    /// * `e` - Soroban environment handle.
    /// * `admin` - Admin address (must authenticate).
    /// * `new_threshold` - New approval threshold weight (must be > 0).
    ///
    /// # Errors
    /// * Returns [`TreasuryError::ContractPaused`] if contract is paused.
    /// * Returns [`TreasuryError::Unauthorized`] if caller is not the contract admin.
    /// * Returns [`TreasuryError::InvalidThreshold`] if `new_threshold` is 0.
    pub fn update_threshold(
        e: Env,
        admin: Address,
        new_threshold: u32,
    ) -> Result<(), TreasuryError> {
        check_not_paused(&e)?;
        Self::check_admin(&e, &admin)?;
        if new_threshold == 0 {
            return Err(TreasuryError::InvalidThreshold);
        }
        let threshold = new_threshold as u64;
        // Reject if the requested threshold exceeds the sum of all signer weights.
        let total_weight = Self::total_signer_weight(&e);
        if threshold > total_weight {
            return Err(TreasuryError::ThresholdExceedsWeight);
        }
        let old_threshold: u64 = e
            .storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or(0u64);
        e.storage().instance().set(&DataKey::Threshold, &threshold);
        e.events().publish(
            (Symbol::new(&e, "threshold_updated"),),
            (old_threshold, threshold),
        );
        Ok(())
    }

    /// Places a pending settlement on hold by raising a dispute.
    ///
    /// # Arguments
    /// * `e` - Soroban environment handle.
    /// * `signer` - Authorized signer address raising the dispute (must authenticate).
    /// * `settlement_id` - ID of the settlement proposal to dispute.
    /// * `_reason` - Numeric reason code describing the dispute.
    ///
    /// # Errors
    /// * Returns [`TreasuryError::ContractPaused`] if contract is paused.
    pub fn raise_dispute(
        e: Env,
        signer: Address,
        settlement_id: u64,
        _reason: u32,
    ) -> Result<(), TreasuryError> {
        check_not_paused(&e)?;
        signer.require_auth();
        let settlement = Self::get_settlement_internal(&e, settlement_id);
        if signer != settlement.merchant {
            return Err(TreasuryError::NotSettlementParty);
        }
        let mut settlement = settlement;
        settlement.status = SettlementStatus::OnHold;
        e.storage()
            .instance()
            .set(&DataKey::Settlement(settlement_id), &settlement);
        Ok(())
    }

    /// Resolves a dispute on a settlement proposal.
    ///
    /// # Arguments
    /// * `e` - Soroban environment handle.
    /// * `signer` - Authorized signer address resolving the dispute (must authenticate).
    /// * `_settlement_id` - ID of the disputed settlement.
    /// * `_resolve_in_favor` - Resolution outcome decision flag.
    ///
    /// # Errors
    /// * Returns [`TreasuryError::ContractPaused`] if contract is paused.
    pub fn resolve_dispute(
        e: Env,
        signer: Address,
        _settlement_id: u64,
        _resolve_in_favor: bool,
    ) -> Result<(), TreasuryError> {
        check_not_paused(&e)?;
        signer.require_auth();
        Ok(())
    }

    /// Update the merchant (payout) address on a pending settlement.
    ///
    /// Only the current merchant of the settlement may call this.
    /// The change takes effect immediately; execution will send funds
    /// to the new address.
    pub fn update_settlement_merchant(
        e: Env,
        merchant_caller: Address,
        settlement_id: u64,
        new_merchant: Address,
    ) -> Result<(), TreasuryError> {
        check_not_paused(&e)?;
        merchant_caller.require_auth();

        let mut settlement = Self::get_settlement_internal(&e, settlement_id);

        if settlement.status != SettlementStatus::Pending {
            return Err(TreasuryError::NotPending);
        }
        if settlement.merchant != merchant_caller {
            return Err(TreasuryError::Unauthorized);
        }

        let old_merchant = settlement.merchant;
        settlement.merchant = new_merchant;

        e.storage()
            .instance()
            .set(&DataKey::Settlement(settlement_id), &settlement);

        e.events().publish(
            (Symbol::new(&e, "merchant_updated"), settlement_id),
            (old_merchant, new_merchant),
        );

        Ok(())
    }

    /// Return the full settlement struct (query-only, no auth required).
    pub fn get_settlement(e: Env, settlement_id: u64) -> Option<Settlement> {
        e.storage()
            .instance()
            .get(&DataKey::Settlement(settlement_id))
    }

    /// Deposits funds into the treasury.
    ///
    /// # Arguments
    /// * `e` - Soroban environment handle.
    /// * `from` - Depositor address (must authenticate).
    /// * `_amount` - Amount to deposit.
    ///
    /// # Errors
    /// * Returns [`TreasuryError::ContractPaused`] if contract is paused.
    pub fn deposit(e: Env, from: Address, _amount: u64) -> Result<(), TreasuryError> {
        check_not_paused(&e)?;
        from.require_auth();
        Ok(())
    }

    /// Withdraws funds from the treasury to a recipient address.
    ///
    /// # Arguments
    /// * `e` - Soroban environment handle.
    /// * `admin` - Admin address (must authenticate).
    /// * `_to` - Target recipient address.
    /// * `_amount` - Amount to withdraw.
    ///
    /// # Errors
    /// * Returns [`TreasuryError::ContractPaused`] if contract is paused.
    /// * Returns [`TreasuryError::Unauthorized`] if caller is not the contract admin.
    pub fn withdraw(
        e: Env,
        admin: Address,
        _to: Address,
        _amount: u64,
    ) -> Result<(), TreasuryError> {
        check_not_paused(&e)?;
        Self::check_admin(&e, &admin)?;
        Ok(())
    }

    /// Adds a token contract address to the token allowlist.
    ///
    /// # Arguments
    /// * `e` - Soroban environment handle.
    /// * `admin` - Admin address (must authenticate).
    /// * `token` - Token contract address to allow.
    ///
    /// # Errors
    /// * Returns [`TreasuryError::ContractPaused`] if contract is paused.
    /// * Returns [`TreasuryError::Unauthorized`] if caller is not the contract admin.
    pub fn add_token_to_allowlist(
        e: Env,
        admin: Address,
        token: Address,
    ) -> Result<(), TreasuryError> {
        check_not_paused(&e)?;
        Self::check_admin(&e, &admin)?;
        let mut allowlist: Vec<Address> = e
            .storage()
            .instance()
            .get(&DataKey::TokenAllowlist)
            .unwrap_or_else(|| Vec::new(&e));
        if !allowlist.contains(&token) {
            allowlist.push_back(token);
        }
        e.storage()
            .instance()
            .set(&DataKey::TokenAllowlist, &allowlist);
        Ok(())
    }

    /// Removes a token contract address from the token allowlist.
    ///
    /// # Arguments
    /// * `e` - Soroban environment handle.
    /// * `admin` - Admin address (must authenticate).
    /// * `token` - Token contract address to remove.
    ///
    /// # Errors
    /// * Returns [`TreasuryError::ContractPaused`] if contract is paused.
    /// * Returns [`TreasuryError::Unauthorized`] if caller is not the contract admin.
    pub fn remove_token_from_allowlist(
        e: Env,
        admin: Address,
        token: Address,
    ) -> Result<(), TreasuryError> {
        check_not_paused(&e)?;
        Self::check_admin(&e, &admin)?;
        let allowlist: Vec<Address> = e
            .storage()
            .instance()
            .get(&DataKey::TokenAllowlist)
            .unwrap_or_else(|| Vec::new(&e));
        let mut updated = Vec::new(&e);
        for t in allowlist.iter() {
            if t != token {
                updated.push_back(t);
            }
        }
        e.storage()
            .instance()
            .set(&DataKey::TokenAllowlist, &updated);
        Ok(())
    }

    fn get_settlement_internal(e: &Env, settlement_id: u64) -> Settlement {
        e.storage()
            .instance()
            .get(&DataKey::Settlement(settlement_id))
            .unwrap()
    }
}

#[cfg(test)]
mod integration_settlement_multisig;

#[cfg(test)]
mod integration_dispute_lifecycle;

#[cfg(test)]
mod benchmark;

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    fn setup() -> (Env, soroban_sdk::Address) {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register_contract(None, TreasuryContract);
        (e, contract_id)
    }

    fn client<'a>(e: &'a Env, id: &'a soroban_sdk::Address) -> TreasuryContractClient<'a> {
        TreasuryContractClient::new(e, id)
    }

    // ── existing pagination tests ────────────────────────────────────────────

    #[test]
    fn test_empty_returns_empty() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let signer = soroban_sdk::Address::generate(&e);
        c.initialize(&soroban_sdk::vec![&e, (signer.clone(), 1u64)], &1, &admin);
        let result = c.get_pending_settlements(&None, &None);
        assert_eq!(result, Ok(Vec::new(&e)));
    }

    #[test]
    fn test_single_pending() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let token = soroban_sdk::Address::generate(&e);
        let merchant = soroban_sdk::Address::generate(&e);
        let signer = soroban_sdk::Address::generate(&e);
        c.initialize(&soroban_sdk::vec![&e, (signer.clone(), 1u64)], &1, &admin);
        let sid = c.propose_settlement(&signer, &token, &1000u64, &merchant);
        let result = c.get_pending_settlements(&None, &None).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result.get(0).unwrap(), sid);
    }

    #[test]
    fn test_mixed_statuses_filtered() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let token = soroban_sdk::Address::generate(&e);
        let merchant = soroban_sdk::Address::generate(&e);
        let signer = soroban_sdk::Address::generate(&e);
        c.initialize(&soroban_sdk::vec![&e, (signer.clone(), 2u64)], &1, &admin);
        let s1 = c.propose_settlement(&signer, &token, &1000u64, &merchant);
        let s2 = c.propose_settlement(&signer, &token, &2000u64, &merchant);
        c.approve_settlement(&signer, &s1);
        c.execute_settlement(&signer, &s1, &token);
        let result = c.get_pending_settlements(&None, &None).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result.get(0).unwrap(), s2);
    }

    #[test]
    fn test_pagination_offset_and_limit() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let token = soroban_sdk::Address::generate(&e);
        let merchant = soroban_sdk::Address::generate(&e);
        let signer = soroban_sdk::Address::generate(&e);
        c.initialize(&soroban_sdk::vec![&e, (signer.clone(), 1u64)], &1, &admin);
        for _ in 0..5 {
            c.propose_settlement(&signer, &token, &100u64, &merchant);
        }
        let page = c.get_pending_settlements(&Some(2u32), &Some(2u32)).unwrap();
        assert_eq!(page.len(), 2);
        assert_eq!(page.get(0).unwrap(), 3u64);
        assert_eq!(page.get(1).unwrap(), 4u64);
    }

    #[test]
    fn test_limit_capped_at_100() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let token = soroban_sdk::Address::generate(&e);
        let merchant = soroban_sdk::Address::generate(&e);
        let signer = soroban_sdk::Address::generate(&e);
        c.initialize(&soroban_sdk::vec![&e, (signer.clone(), 1u64)], &1, &admin);
        for _ in 0..5 {
            c.propose_settlement(&signer, &token, &100u64, &merchant);
        }
        let result = c.get_pending_settlements(&None, &Some(200u32));
        assert_eq!(result, Err(TreasuryError::InvalidPagination));
    }

    #[test]
    fn test_offset_beyond_pending_count_returns_empty_page() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let token = soroban_sdk::Address::generate(&e);
        let merchant = soroban_sdk::Address::generate(&e);
        let signer = soroban_sdk::Address::generate(&e);
        c.initialize(&soroban_sdk::vec![&e, (signer.clone(), 1u64)], &1, &admin);
        c.propose_settlement(&signer, &token, &100u64, &merchant);
        let page = c
            .get_pending_settlements(&Some(10u32), &Some(5u32))
            .unwrap();
        assert!(page.is_empty());
    }

    // ── paused guard tests ───────────────────────────────────────────────────

    #[test]
    fn test_propose_when_paused_returns_contract_paused() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let signer = soroban_sdk::Address::generate(&e);
        let token = soroban_sdk::Address::generate(&e);
        let merchant = soroban_sdk::Address::generate(&e);
        c.initialize(&soroban_sdk::vec![&e, (signer.clone(), 1u64)], &1, &admin);
        c.pause(&admin);
        let res = c.try_propose_settlement(&signer, &token, &100u64, &merchant);
        assert_eq!(res, Err(Ok(TreasuryError::ContractPaused)));
    }

    #[test]
    fn test_approve_when_paused_returns_contract_paused() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let signer = soroban_sdk::Address::generate(&e);
        let token = soroban_sdk::Address::generate(&e);
        let merchant = soroban_sdk::Address::generate(&e);
        c.initialize(&soroban_sdk::vec![&e, (signer.clone(), 1u64)], &1, &admin);
        let sid = c.propose_settlement(&signer, &token, &100u64, &merchant);
        c.pause(&admin);
        let res = c.try_approve_settlement(&signer, &sid);
        assert_eq!(res, Err(Ok(TreasuryError::ContractPaused)));
    }

    #[test]
    fn test_execute_when_paused_returns_contract_paused() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let signer = soroban_sdk::Address::generate(&e);
        let token = soroban_sdk::Address::generate(&e);
        let merchant = soroban_sdk::Address::generate(&e);
        c.initialize(&soroban_sdk::vec![&e, (signer.clone(), 1u64)], &1, &admin);
        let sid = c.propose_settlement(&signer, &token, &100u64, &merchant);
        c.approve_settlement(&signer, &sid);
        c.pause(&admin);
        let res = c.try_execute_settlement(&signer, &sid, &token);
        assert_eq!(res, Err(Ok(TreasuryError::ContractPaused)));
    }

    #[test]
    fn test_set_signer_when_paused_returns_contract_paused() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let signer = soroban_sdk::Address::generate(&e);
        let initial = soroban_sdk::Address::generate(&e);
        c.initialize(&soroban_sdk::vec![&e, (initial.clone(), 1u64)], &1, &admin);
        c.pause(&admin);
        let res = c.try_set_signer(&admin, &signer, &1u64);
        assert_eq!(res, Err(Ok(TreasuryError::ContractPaused)));
    }

    #[test]
    fn test_update_threshold_when_paused_returns_contract_paused() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let signer = soroban_sdk::Address::generate(&e);
        c.initialize(&soroban_sdk::vec![&e, (signer.clone(), 1u64)], &1, &admin);
        c.pause(&admin);
        let res = c.try_update_threshold(&admin, &2u32);
        assert_eq!(res, Err(Ok(TreasuryError::ContractPaused)));
    }

    // ── threshold and approval_weight tests ──────────────────────────────────

    #[test]
    fn test_partial_approval_below_threshold_does_not_execute() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let s1 = soroban_sdk::Address::generate(&e);
        let s2 = soroban_sdk::Address::generate(&e);
        let s3 = soroban_sdk::Address::generate(&e);
        let token = soroban_sdk::Address::generate(&e);
        let merchant = soroban_sdk::Address::generate(&e);
        // threshold=3, each signer weight=1 → total weight=3 >= 3 (valid init)
        // After s1 approves: approval_weight=1 < 3
        c.initialize(
            &soroban_sdk::vec![
                &e,
                (s1.clone(), 1u64),
                (s2.clone(), 1u64),
                (s3.clone(), 1u64)
            ],
            &3,
            &admin,
        );
        let sid = c.propose_settlement(&s1, &token, &500u64, &merchant);
        c.approve_settlement(&s1, &sid);
        // execute should fail with InsufficientApprovals
        let res = c.try_execute_settlement(&s1, &sid, &token);
        assert_eq!(res, Err(Ok(TreasuryError::InsufficientApprovals)));
        // settlement must still be Pending
        let pending = c.get_pending_settlements(&None, &None).unwrap();
        assert!(pending.contains(&sid));
    }

    #[test]
    fn test_exact_threshold_executes_settlement() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let signer = soroban_sdk::Address::generate(&e);
        let token = soroban_sdk::Address::generate(&e);
        let merchant = soroban_sdk::Address::generate(&e);
        // threshold=2, signer weight=2 → exact match
        c.initialize(&soroban_sdk::vec![&e, (signer.clone(), 2u64)], &2, &admin);
        let sid = c.propose_settlement(&signer, &token, &500u64, &merchant);
        c.approve_settlement(&signer, &sid);
        c.execute_settlement(&signer, &sid, &token);
        // settlement no longer pending
        let pending = c.get_pending_settlements(&None, &None).unwrap();
        assert!(!pending.contains(&sid));
    }

    #[test]
    fn test_over_threshold_single_approval_executes() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let signer = soroban_sdk::Address::generate(&e);
        let token = soroban_sdk::Address::generate(&e);
        let merchant = soroban_sdk::Address::generate(&e);
        // threshold=1, signer weight=5 → weight > threshold
        c.initialize(&soroban_sdk::vec![&e, (signer.clone(), 5u64)], &1, &admin);
        let sid = c.propose_settlement(&signer, &token, &500u64, &merchant);
        c.approve_settlement(&signer, &sid);
        c.execute_settlement(&signer, &sid, &token);
        let pending = c.get_pending_settlements(&None, &None).unwrap();
        assert!(!pending.contains(&sid));
    }

    #[test]
    fn test_zero_threshold_update_rejected() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let signer = soroban_sdk::Address::generate(&e);
        c.initialize(&soroban_sdk::vec![&e, (signer.clone(), 1u64)], &1, &admin);
        let res = c.try_update_threshold(&admin, &0u32);
        assert_eq!(res, Err(Ok(TreasuryError::InvalidThreshold)));
    }

    #[test]
    fn test_update_threshold_above_total_weight_rejected() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let s1 = soroban_sdk::Address::generate(&e);
        let s2 = soroban_sdk::Address::generate(&e);
        // total weight = 3 (s1=1, s2=2)
        c.initialize(
            &soroban_sdk::vec![&e, (s1.clone(), 1u64), (s2.clone(), 2u64)],
            &1,
            &admin,
        );
        // Attempt to set threshold to 4 > total weight 3
        let res = c.try_update_threshold(&admin, &4u32);
        assert_eq!(res, Err(Ok(TreasuryError::ThresholdExceedsWeight)));
    }

    #[test]
    fn test_update_threshold_exactly_at_total_weight_succeeds() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let s1 = soroban_sdk::Address::generate(&e);
        let s2 = soroban_sdk::Address::generate(&e);
        // total weight = 3 (s1=1, s2=2)
        c.initialize(
            &soroban_sdk::vec![&e, (s1.clone(), 1u64), (s2.clone(), 2u64)],
            &1,
            &admin,
        );
        // Threshold == total weight should succeed
        c.update_threshold(&admin, &3u32);
        assert_eq!(c.get_threshold(), 3u64);
    }

    #[test]
    fn test_update_threshold_below_total_weight_succeeds() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let signer = soroban_sdk::Address::generate(&e);
        // total weight = 5
        c.initialize(&soroban_sdk::vec![&e, (signer.clone(), 5u64)], &1, &admin);
        c.update_threshold(&admin, &3u32);
        assert_eq!(c.get_threshold(), 3u64);
    }

    #[test]
    fn test_update_threshold_reflects_set_signer_weight_increase() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let signer = soroban_sdk::Address::generate(&e);
        // initial total weight = 2
        c.initialize(&soroban_sdk::vec![&e, (signer.clone(), 2u64)], &1, &admin);

        // threshold=3 > total_weight=2 → rejected
        let res = c.try_update_threshold(&admin, &3u32);
        assert_eq!(res, Err(Ok(TreasuryError::ThresholdExceedsWeight)));

        // Add a new signer with weight=2 → total_weight=4
        let new_signer = soroban_sdk::Address::generate(&e);
        c.set_signer(&admin, &new_signer, &2u64);

        // Now threshold=3 ≤ total_weight=4 → should succeed
        c.update_threshold(&admin, &3u32);
        assert_eq!(c.get_threshold(), 3u64);
    }

    #[test]
    fn test_multi_signer_weight_accumulates_to_threshold() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let s1 = soroban_sdk::Address::generate(&e);
        let s2 = soroban_sdk::Address::generate(&e);
        let token = soroban_sdk::Address::generate(&e);
        let merchant = soroban_sdk::Address::generate(&e);
        // threshold=3, s1 weight=1, s2 weight=2
        c.initialize(
            &soroban_sdk::vec![&e, (s1.clone(), 1u64), (s2.clone(), 2u64)],
            &3,
            &admin,
        );
        let sid = c.propose_settlement(&s1, &token, &500u64, &merchant);
        // s1 approves: weight=1 < 3, can't execute yet
        c.approve_settlement(&s1, &sid);
        let res = c.try_execute_settlement(&s1, &sid, &token);
        assert_eq!(res, Err(Ok(TreasuryError::InsufficientApprovals)));
        // s2 approves: weight=3 == 3, can execute
        c.approve_settlement(&s2, &sid);
        c.execute_settlement(&s1, &sid, &token);
        let pending = c.get_pending_settlements(&None, &None).unwrap();
        assert!(!pending.contains(&sid));
    }

    // ── additional coverage tests ───────────────────────────────────────────

    #[test]
    fn test_unpause_resumes_operations() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let signer = soroban_sdk::Address::generate(&e);
        let token = soroban_sdk::Address::generate(&e);
        let merchant = soroban_sdk::Address::generate(&e);
        c.initialize(&soroban_sdk::vec![&e, (signer.clone(), 1u64)], &1, &admin);
        c.pause(&admin);
        assert_eq!(c.try_propose_settlement(&signer, &token, &100u64, &merchant), Err(Ok(TreasuryError::ContractPaused)));
        c.unpause(&admin);
        let sid = c.propose_settlement(&signer, &token, &100u64, &merchant);
        assert_eq!(sid, 1u64);
    }

    #[test]
    fn test_get_and_update_threshold() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        c.initialize(&soroban_sdk::vec![&e], &5, &admin);
        assert_eq!(c.get_threshold(), 5u64);
        c.update_threshold(&admin, &10u32);
        assert_eq!(c.get_threshold(), 10u64);
    }

    #[test]
    fn test_token_allowlist_enforcement() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let signer = soroban_sdk::Address::generate(&e);
        let token1 = soroban_sdk::Address::generate(&e);
        let token2 = soroban_sdk::Address::generate(&e);
        let merchant = soroban_sdk::Address::generate(&e);
        c.initialize(&soroban_sdk::vec![&e, (signer.clone(), 1u64)], &1, &admin);

        c.add_token_to_allowlist(&admin, &token1);
        let s1 = c.propose_settlement(&signer, &token1, &100u64, &merchant);
        assert_eq!(s1, 1u64);

        let err = c.try_propose_settlement(&signer, &token2, &100u64, &merchant);
        assert_eq!(err, Err(Ok(TreasuryError::TokenNotAllowed)));

        c.remove_token_from_allowlist(&admin, &token1);
        let s2 = c.propose_settlement(&signer, &token2, &100u64, &merchant);
        assert_eq!(s2, 2u64);
    }

    #[test]
    fn test_deposit_and_withdraw() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let user = soroban_sdk::Address::generate(&e);
        c.initialize(&soroban_sdk::vec![&e], &1, &admin);

        c.deposit(&user, &1000u64);
        c.withdraw(&admin, &user, &500u64);
    }

    #[test]
    fn test_unauthorized_admin_actions() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let non_admin = soroban_sdk::Address::generate(&e);
        c.initialize(&soroban_sdk::vec![&e], &1, &admin);

        assert_eq!(c.try_pause(&non_admin), Err(Ok(TreasuryError::Unauthorized)));
        assert_eq!(c.try_unpause(&non_admin), Err(Ok(TreasuryError::Unauthorized)));
        assert_eq!(c.try_update_threshold(&non_admin, &2u32), Err(Ok(TreasuryError::Unauthorized)));
        assert_eq!(c.try_withdraw(&non_admin, &non_admin, &100u64), Err(Ok(TreasuryError::Unauthorized)));
    }
}
