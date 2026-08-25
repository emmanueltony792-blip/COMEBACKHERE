#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, Symbol, Vec};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ContractError {
    Unauthorized = 1,
    ContractPaused = 2,
    AlreadyInitialized = 3,
    AddressNotFound = 4,
}

#[contracttype]
pub enum AddressStatus {
    Allowed,
    AllowedUntil(u64),
    Blocked,
    Cleared,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Paused,
    Status(Address),
    PendingAdmin,
}

#[contract]
pub struct ComplianceContract;

fn is_paused(e: &Env) -> bool {
    e.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

fn check_not_paused(e: &Env) -> Result<(), ContractError> {
    if is_paused(e) {
        Err(ContractError::ContractPaused)
    } else {
        Ok(())
    }
}

#[contractimpl]
impl ComplianceContract {
    pub fn initialize(e: Env, admin: Address) {
        e.storage().instance().set(&DataKey::Admin, &admin);
        e.storage().instance().set(&DataKey::Paused, &false);
    }

    pub fn is_allowed(e: Env, addr: Address) -> bool {
        match e
            .storage()
            .instance()
            .get(&DataKey::Status(addr))
            .unwrap_or(AddressStatus::Cleared)
        {
            AddressStatus::Allowed => true,
            AddressStatus::AllowedUntil(until) => e.ledger().timestamp() < until,
            AddressStatus::Blocked | AddressStatus::Cleared => false,
        }
    }

    pub fn get_address_status(e: Env, addr: Address) -> AddressStatus {
        e.storage()
            .instance()
            .get(&DataKey::Status(addr))
            .unwrap_or(AddressStatus::Cleared)
    }

    pub fn allow_address(e: Env, admin: Address, addr: Address) -> Result<(), ContractError> {
        check_not_paused(&e)?;
        admin.require_auth();
        e.storage()
            .instance()
            .set(&DataKey::Status(addr.clone()), &AddressStatus::Allowed);
        e.events()
            .publish((Symbol::new(&e, "address_allowed"),), addr);
        Ok(())
    }

    pub fn block_address(e: Env, admin: Address, addr: Address) -> Result<(), ContractError> {
        check_not_paused(&e)?;
        admin.require_auth();
        e.storage()
            .instance()
            .set(&DataKey::Status(addr.clone()), &AddressStatus::Blocked);
        e.events()
            .publish((Symbol::new(&e, "address_blocked"),), addr);
        Ok(())
    }

    pub fn allow_address_until(
        e: Env,
        admin: Address,
        addr: Address,
        until: u64,
    ) -> Result<(), ContractError> {
        check_not_paused(&e)?;
        admin.require_auth();
        e.storage().instance().set(
            &DataKey::Status(addr.clone()),
            &AddressStatus::AllowedUntil(until),
        );
        e.events()
            .publish((Symbol::new(&e, "address_allowed_until"),), (addr, until));
        Ok(())
    }

    pub fn transfer_admin(e: Env, admin: Address, new_admin: Address) -> Result<(), ContractError> {
        check_not_paused(&e)?;
        admin.require_auth();
        e.storage().instance().set(&DataKey::Admin, &new_admin);
        Ok(())
    }

    pub fn accept_admin(e: Env, new_admin: Address) -> Result<(), ContractError> {
        check_not_paused(&e)?;
        new_admin.require_auth();
        let pending: Address = e
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .ok_or(ContractError::Unauthorized)?;
        if new_admin != pending {
            return Err(ContractError::Unauthorized);
        }
        e.storage().instance().set(&DataKey::Admin, &new_admin);
        e.storage().instance().remove(&DataKey::PendingAdmin);
        e.events()
            .publish((Symbol::new(&e, "accept_admin"),), &new_admin);
        Ok(())
    }

    /// Removes the storage entry for `addr` from the specified list.
    /// Returns `AddressNotFound` if the address has no active status (already cleared or never set).
    pub fn clear_address(e: Env, admin: Address, addr: Address) -> Result<(), ContractError> {
        check_not_paused(&e)?;
        admin.require_auth();
        let status: AddressStatus = e
            .storage()
            .instance()
            .get(&DataKey::Status(addr.clone()))
            .unwrap_or(AddressStatus::Cleared);
        if matches!(status, AddressStatus::Cleared) {
            return Err(ContractError::AddressNotFound);
        }
        e.storage()
            .instance()
            .remove(&DataKey::Status(addr.clone()));
        e.events()
            .publish((Symbol::new(&e, "address_cleared"),), (addr, status));
        Ok(())
    }

    pub fn pause(e: Env, admin: Address) -> Result<(), ContractError> {
        admin.require_auth();
        let stored_admin: Address = e.storage().instance().get(&DataKey::Admin).unwrap();
        if admin != stored_admin {
            return Err(ContractError::Unauthorized);
        }
        e.storage().instance().set(&DataKey::Paused, &true);
        e.events()
            .publish((Symbol::new(&e, "contract_paused"),), ());
        Ok(())
    }

    pub fn unpause(e: Env, admin: Address) -> Result<(), ContractError> {
        admin.require_auth();
        let stored_admin: Address = e.storage().instance().get(&DataKey::Admin).unwrap();
        if admin != stored_admin {
            return Err(ContractError::Unauthorized);
        }
        e.storage().instance().set(&DataKey::Paused, &false);
        e.events()
            .publish((Symbol::new(&e, "contract_unpaused"),), ());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::Env;

    fn setup(ts: u64) -> (Env, Address, Address, Address) {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(ComplianceContract, ());
        let admin = Address::generate(&e);
        let addr = Address::generate(&e);
        ComplianceContractClient::new(&e, &contract_id).initialize(&admin);
        e.ledger().with_mut(|li| li.timestamp = ts);
        (e, contract_id, admin, addr)
    }

    // ── existing expiry tests ────────────────────────────────────────────────

    #[test]
    fn test_is_allowed_not_expired() {
        let (e, cid, admin, addr) = setup(1000);
        let c = ComplianceContractClient::new(&e, &cid);
        c.allow_address_until(&admin, &addr, &2000u64);
        assert!(c.is_allowed(&addr));
    }

    #[test]
    fn test_is_allowed_exactly_at_expiry_returns_false() {
        let (e, cid, admin, addr) = setup(1000);
        let c = ComplianceContractClient::new(&e, &cid);
        c.allow_address_until(&admin, &addr, &1000u64);
        assert!(!c.is_allowed(&addr));
    }

    #[test]
    fn test_is_allowed_past_expiry_returns_false() {
        let (e, cid, admin, addr) = setup(1001);
        let c = ComplianceContractClient::new(&e, &cid);
        c.allow_address_until(&admin, &addr, &1000u64);
        assert!(!c.is_allowed(&addr));
    }

    #[test]
    fn test_permanent_allow_unaffected_by_time() {
        let (_e, c, admin, addr) = setup(9999);
        c.allow_address(&admin, &addr);
        assert!(c.is_allowed(&addr));
    }

    // ── pause / unpause and admin guard tests ─────────────────────────────────

    #[test]
    fn test_pause_emits_event() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(ComplianceContract, ());
        let admin = Address::generate(&e);
        ComplianceContractClient::new(&e, &contract_id).initialize(&admin);
        let c = ComplianceContractClient::new(&e, &contract_id);

        c.pause(&admin);

        let all_events = e.events().all();
        assert!(
            all_events.iter().any(|ev| ev.0 == (contract_id, "contract_paused".into())),
            "contract_paused event should be emitted"
        );
    }

    #[test]
    fn test_unpause_emits_event() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(ComplianceContract, ());
        let admin = Address::generate(&e);
        ComplianceContractClient::new(&e, &contract_id).initialize(&admin);
        let c = ComplianceContractClient::new(&e, &contract_id);

        c.pause(&admin);
        c.unpause(&admin);

        let all_events = e.events().all();
        assert!(
            all_events.iter().any(|ev| ev.0 == (contract_id, "contract_unpaused".into())),
            "contract_unpaused event should be emitted"
        );
    }

    #[test]
    fn test_pause_unauthorized_fails() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(ComplianceContract, ());
        let admin = Address::generate(&e);
        let non_admin = Address::generate(&e);
        ComplianceContractClient::new(&e, &contract_id).initialize(&admin);
        let c = ComplianceContractClient::new(&e, &contract_id);

        let res = c.try_pause(&non_admin);
        assert_eq!(res, Err(Ok(ContractError::Unauthorized)));
    }

    #[test]
    fn test_unpause_unauthorized_fails() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(ComplianceContract, ());
        let admin = Address::generate(&e);
        let non_admin = Address::generate(&e);
        ComplianceContractClient::new(&e, &contract_id).initialize(&admin);
        let c = ComplianceContractClient::new(&e, &contract_id);

        c.pause(&admin);
        let res = c.try_unpause(&non_admin);
        assert_eq!(res, Err(Ok(ContractError::Unauthorized)));
    }

    #[test]
    fn test_accept_admin_when_paused_fails() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(ComplianceContract, ());
        let admin = Address::generate(&e);
        let new_admin = Address::generate(&e);
        ComplianceContractClient::new(&e, &contract_id).initialize(&admin);
        let c = ComplianceContractClient::new(&e, &contract_id);

        c.pause(&admin);
        let res = c.try_accept_admin(&new_admin);
        assert_eq!(res, Err(Ok(ContractError::ContractPaused)));
    }

    #[test]
    fn test_mutating_entrypoints_blocked_when_paused() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(ComplianceContract, ());
        let admin = Address::generate(&e);
        let addr = Address::generate(&e);
        ComplianceContractClient::new(&e, &contract_id).initialize(&admin);
        let c = ComplianceContractClient::new(&e, &contract_id);

        c.pause(&admin);

        assert_eq!(
            c.try_allow_address(&admin, &addr),
            Err(Ok(ContractError::ContractPaused))
        );
        assert_eq!(
            c.try_block_address(&admin, &addr),
            Err(Ok(ContractError::ContractPaused))
        );
        assert_eq!(
            c.try_allow_address_until(&admin, &addr, &1000u64),
            Err(Ok(ContractError::ContractPaused))
        );
        assert_eq!(
            c.try_clear_address(&admin, &addr),
            Err(Ok(ContractError::ContractPaused))
        );
    }

    #[test]
    fn test_readonly_entrypoints_work_when_paused() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(ComplianceContract, ());
        let admin = Address::generate(&e);
        let addr = Address::generate(&e);
        ComplianceContractClient::new(&e, &contract_id).initialize(&admin);
        let c = ComplianceContractClient::new(&e, &contract_id);

        c.allow_address(&admin, &addr);
        c.pause(&admin);

        assert!(c.is_allowed(&addr));
        let status = c.get_address_status(&addr);
        assert!(matches!(status, AddressStatus::Allowed));
    }
}
