#![no_std]

mod events;

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Env, IntoVal, Symbol, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ContractError {
    Unauthorized = 1,
    ContractPaused = 2,
    AlreadyInitialized = 3,
    InvoiceNotFound = 4,
    InvoiceAlreadyPaid = 5,
    InvoiceExpired = 6,
    InvoiceCancelled = 7,
    NotMerchant = 8,
    NotCustomer = 9,
    RefundNotRequested = 10,
    AlreadyRefundRequested = 11,
    GraceWindowNotExpired = 12,
    DuplicateNonce = 13,
    TreasuryNotConfigured = 14,
    NotAParty = 15,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InvoiceStatus {
    Pending,
    Paid,
    Expired,
    Cancelled,
    RefundRequested,
    Released,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Invoice {
    pub id: u64,
    pub merchant: Address,
    pub customer: Address,
    pub amount: i128,
    pub token: Address,
    pub status: InvoiceStatus,
    pub created_at: u64,
    pub expires_at: u64,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Paused,
    Invoice(u64),
    InvoiceCount,
    GraceWindow,
    Nonce(Address, u64),
    TreasuryContract,
    ComplianceContract,
}

fn admin(env: &Env) -> Address {
    env.storage().persistent().get(&DataKey::Admin).unwrap()
}

fn is_paused(env: &Env) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

fn check_not_paused(env: &Env) -> Result<(), ContractError> {
    if is_paused(env) {
        Err(ContractError::ContractPaused)
    } else {
        Ok(())
    }
}

fn check_admin(env: &Env, addr: &Address) -> Result<(), ContractError> {
    if addr != &admin(env) {
        Err(ContractError::Unauthorized)
    } else {
        Ok(())
    }
}

/// The invoice contract manages the full lifecycle of on-chain invoices:
/// creation, payment, cancellation, refund requests, escrow release, and disputes.
///
/// Disputes are resolved via a cross-contract call to the configured treasury contract.
/// Most mutating operations are guarded by a pause mechanism that only the admin can toggle.
#[contract]
pub struct InvoiceContract;

#[contractimpl]
impl InvoiceContract {
    /// Initialises the contract, setting the admin address and default configuration.
    ///
    /// # Parameters
    /// - `admin`: The address that will have administrative privileges (pause/unpause,
    ///   set grace window, set treasury, etc.).
    ///
    /// # Errors
    /// - [`ContractError::AlreadyInitialized`] if `initialize` has already been called.
    ///
    /// # Storage written
    /// Sets `Admin`, `GraceWindow` (default 86 400 s), `InvoiceCount` (0), and `Paused` (false).
    pub fn initialize(env: Env, admin: Address) -> Result<(), ContractError> {
        if env.storage().persistent().has(&DataKey::Admin) {
            return Err(ContractError::AlreadyInitialized);
        }
        env.storage().persistent().set(&DataKey::Admin, &admin);
        env.storage()
            .persistent()
            .set(&DataKey::GraceWindow, &86400u64);
        env.storage()
            .persistent()
            .set(&DataKey::InvoiceCount, &0u64);
        env.storage().persistent().set(&DataKey::Paused, &false);
        Ok(())
    }

    /// Creates a new invoice and stores it in persistent storage.
    ///
    /// Requires the merchant to have authorised this call (`merchant.require_auth()`).
    /// The `nonce` is scoped per-merchant, so two different merchants may use the same
    /// nonce value without collision.
    ///
    /// # Parameters
    /// - `merchant`: The address of the invoice creator; must authorise the transaction.
    /// - `customer`: The address of the intended payer.
    /// - `amount`: The invoice amount in the smallest unit of `token`.
    /// - `token`: The Stellar asset contract address used for payment.
    /// - `expires_at`: Absolute ledger timestamp (seconds since Unix epoch) after which
    ///   the invoice can no longer be paid.
    /// - `nonce`: A per-merchant unique value used to prevent duplicate submissions.
    ///
    /// # Returns
    /// The newly assigned invoice ID (a `u64` counter starting at 1).
    ///
    /// # Errors
    /// - [`ContractError::ContractPaused`] if the contract is currently paused.
    /// - [`ContractError::DuplicateNonce`] if `(merchant, nonce)` has already been used.
    ///
    /// # Events
    /// Emits `invoice_created(merchant, invoice_id)` on success.
    pub fn create_invoice(
        env: Env,
        merchant: Address,
        customer: Address,
        amount: i128,
        token: Address,
        expires_at: u64,
        nonce: u64,
    ) -> Result<u64, ContractError> {
        check_not_paused(&env)?;
        merchant.require_auth();

        let nonce_key = DataKey::Nonce(merchant.clone(), nonce);
        if env.storage().persistent().has(&nonce_key) {
            return Err(ContractError::DuplicateNonce);
        }
        env.storage().persistent().set(&nonce_key, &true);

        let mut count: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::InvoiceCount)
            .unwrap_or(0);
        count = count.checked_add(1).ok_or(ContractError::Overflow)?;
        env.storage()
            .persistent()
            .set(&DataKey::InvoiceCount, &count);

        let now = env.ledger().timestamp();
        let invoice = Invoice {
            id: count,
            merchant: merchant.clone(),
            customer,
            amount,
            token,
            status: InvoiceStatus::Pending,
            created_at: now,
            expires_at,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Invoice(count), &invoice);

        events::invoice_created(&env, &merchant, &count);
        Ok(count)
    }

    /// Returns the full [`Invoice`] struct for a given ID.
    ///
    /// # Parameters
    /// - `invoice_id`: The numeric ID returned by `create_invoice`.
    ///
    /// # Errors
    /// - [`ContractError::InvoiceNotFound`] if no invoice with that ID exists.
    pub fn get_invoice(env: Env, invoice_id: u64) -> Result<Invoice, ContractError> {
        env.storage()
            .persistent()
            .get(&DataKey::Invoice(invoice_id))
            .ok_or(ContractError::InvoiceNotFound)
    }

    /// Returns only the [`InvoiceStatus`] for a given invoice ID, without fetching
    /// the full invoice. Useful for lightweight status polling.
    ///
    /// # Parameters
    /// - `invoice_id`: The numeric invoice ID.
    ///
    /// # Errors
    /// - [`ContractError::InvoiceNotFound`] if no invoice with that ID exists.
    pub fn get_invoice_status(env: Env, invoice_id: u64) -> Result<InvoiceStatus, ContractError> {
        let invoice = env
            .storage()
            .persistent()
            .get::<DataKey, Invoice>(&DataKey::Invoice(invoice_id))
            .ok_or(ContractError::InvoiceNotFound)?;
        Ok(invoice.status)
    }

    /// Marks a batch of invoices as [`InvoiceStatus::Paid`] in a single transaction.
    ///
    /// Each invoice in the batch must be in `Pending` status and must not have expired.
    /// Processing stops and returns an error on the first failure — no partial updates
    /// are committed when an error is returned.
    ///
    /// # Parameters
    /// - `invoice_ids`: A vector of invoice IDs to mark as paid.
    ///
    /// # Errors
    /// - [`ContractError::ContractPaused`] if the contract is currently paused.
    /// - [`ContractError::InvoiceNotFound`] if any ID in the batch does not exist.
    /// - [`ContractError::InvoiceAlreadyPaid`] if any invoice is not in `Pending` status.
    /// - [`ContractError::InvoiceExpired`] if any invoice's `expires_at` has passed.
    ///
    /// # Events
    /// Emits `invoice_paid(invoice_id)` for each successfully marked invoice.
    pub fn mark_paids(env: Env, invoice_ids: Vec<u64>) -> Result<(), ContractError> {
        check_not_paused(&env)?;

        // Resolve compliance contract once; if set, every invoice
        // customer must be allowed.
        let compliance: Option<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::ComplianceContract);

        for id in invoice_ids.iter() {
            let mut invoice = env
                .storage()
                .persistent()
                .get::<DataKey, Invoice>(&DataKey::Invoice(id))
                .ok_or(ContractError::InvoiceNotFound)?;
            if invoice.status != InvoiceStatus::Pending {
                return Err(ContractError::InvoiceAlreadyPaid);
            }
            if env.ledger().timestamp() >= invoice.expires_at {
                return Err(ContractError::InvoiceExpired);
            }

            // Compliance check: reject if customer is blocked
            if let Some(ref compliance_addr) = compliance {
                let is_allowed: bool = env.invoke_contract(
                    compliance_addr,
                    &Symbol::new(&env, "is_allowed"),
                    soroban_sdk::vec![&env, invoice.customer.clone().into_val(&env)],
                );
                if !is_allowed {
                    return Err(ContractError::AddressBlocked);
                }
            }

            invoice.status = InvoiceStatus::Paid;
            env.storage()
                .persistent()
                .set(&DataKey::Invoice(id), &invoice);
            events::invoice_paid(&env, &id);
        }
        Ok(())
    }

    /// Cancels a `Pending` invoice. Either the merchant or the customer may call this.
    ///
    /// # Parameters
    /// - `invoice_id`: The ID of the invoice to cancel.
    /// - `caller`: The address requesting the cancellation; must be the merchant or customer.
    ///
    /// # Errors
    /// - [`ContractError::ContractPaused`] if the contract is currently paused.
    /// - [`ContractError::InvoiceNotFound`] if no invoice with that ID exists.
    /// - [`ContractError::Unauthorized`] if `caller` is neither the merchant nor the customer.
    /// - [`ContractError::InvoiceCancelled`] if the invoice is not in `Pending` status.
    ///
    /// # Events
    /// Emits `invoice_cancelled(invoice_id)` on success.
    pub fn cancel_invoiced(env: Env, invoice_id: u64, caller: Address) -> Result<(), ContractError> {
        check_not_paused(&env)?;
        caller.require_auth();
        let mut invoice = env
            .storage()
            .persistent()
            .get::<DataKey, Invoice>(&DataKey::Invoice(invoice_id))
            .ok_or(ContractError::InvoiceNotFound)?;
        if caller != invoice.merchant && caller != invoice.customer {
            return Err(ContractError::Unauthorized);
        }

        match invoice.status {
            // No funds have moved yet — simple cancellation.
            InvoiceStatus::Pending => {
                invoice.status = InvoiceStatus::Cancelled;
                env.storage()
                    .persistent()
                    .set(&DataKey::Invoice(invoice_id), &invoice);
                events::invoice_cancelled(&env, &invoice_id);
                Ok(())
            }
            // Funds are held in escrow. Cancellation initiates the refund path by
            // transitioning to RefundRequested so the release_escrow flow can
            // complete the refund without leaving funds stuck.
            InvoiceStatus::Paid => {
                invoice.status = InvoiceStatus::RefundRequested;
                env.storage()
                    .persistent()
                    .set(&DataKey::Invoice(invoice_id), &invoice);
                events::invoice_refund_req(&env, &invoice_id);
                Ok(())
            }
            // A refund is already in progress — return a descriptive error.
            InvoiceStatus::RefundRequested => Err(ContractError::AlreadyRefundRequested),
            // Terminal states: Expired, Released, Cancelled cannot be cancelled again.
            InvoiceStatus::Expired | InvoiceStatus::Released | InvoiceStatus::Cancelled => {
                Err(ContractError::InvoiceCancelled)
            }
        }
    }

    /// Requests a refund for a `Paid` invoice. Only the customer may call this.
    ///
    /// Transitions the invoice from [`InvoiceStatus::Paid`] to
    /// [`InvoiceStatus::RefundRequested`], which then allows the merchant to call
    /// `release_escrow` once the grace window has elapsed.
    ///
    /// # Parameters
    /// - `invoice_id`: The ID of the invoice to refund.
    /// - `caller`: Must be the invoice's `customer` address.
    ///
    /// # Errors
    /// - [`ContractError::ContractPaused`] if the contract is currently paused.
    /// - [`ContractError::InvoiceNotFound`] if no invoice with that ID exists or the
    ///   invoice is not in `Paid` status.
    /// - [`ContractError::NotCustomer`] if `caller` is not the invoice customer.
    /// - [`ContractError::AlreadyRefundRequested`] if a refund has already been requested.
    ///
    /// # Events
    /// Emits `invoice_refund_req(invoice_id)` on success.
    pub fn request_refund(
        env: Env,
        invoice_id: u64,
        caller: Address,
    ) -> Result<(), ContractError> {
        check_not_paused(&env)?;
        let mut invoice = env
            .storage()
            .persistent()
            .get::<DataKey, Invoice>(&DataKey::Invoice(invoice_id))
            .ok_or(ContractError::InvoiceNotFound)?;
        if caller != invoice.customer {
            return Err(ContractError::NotCustomer);
        }
        if invoice.status != InvoiceStatus::Paid {
            return Err(ContractError::InvoiceNotFound);
        }
        if invoice.status == InvoiceStatus::RefundRequested {
            return Err(ContractError::AlreadyRefundRequested);
        }
        invoice.status = InvoiceStatus::RefundRequested;
        env.storage()
            .persistent()
            .set(&DataKey::Invoice(invoice_id), &invoice);
        events::invoice_refund_req(&env, &invoice_id);
        Ok(())
    }

    /// Releases an escrow hold after the refund grace window has expired.
    /// Only the merchant may call this, and only when the invoice is in
    /// [`InvoiceStatus::RefundRequested`].
    ///
    /// The grace window (default 86 400 s) is measured from `invoice.created_at`.
    /// Adjustable by the admin via `set_grace_window`.
    ///
    /// # Parameters
    /// - `invoice_id`: The ID of the invoice whose escrow is to be released.
    /// - `caller`: Must be the invoice's `merchant` address.
    ///
    /// # Errors
    /// - [`ContractError::ContractPaused`] if the contract is currently paused.
    /// - [`ContractError::InvoiceNotFound`] if no invoice with that ID exists.
    /// - [`ContractError::NotMerchant`] if `caller` is not the invoice merchant.
    /// - [`ContractError::RefundNotRequested`] if the invoice is not in `RefundRequested` status.
    /// - [`ContractError::GraceWindowNotExpired`] if the current ledger timestamp is still
    ///   within `created_at + grace_window`.
    ///
    /// # Events
    /// Emits `escrow_released(invoice_id)` on success.
    pub fn release_escrow(
        env: Env,
        invoice_id: u64,
        caller: Address,
    ) -> Result<(), ContractError> {
        check_not_paused(&env)?;
        let mut invoice = env
            .storage()
            .persistent()
            .get::<DataKey, Invoice>(&DataKey::Invoice(invoice_id))
            .ok_or(ContractError::InvoiceNotFound)?;
        if caller != invoice.merchant {
            return Err(ContractError::NotMerchant);
        }
        if invoice.status != InvoiceStatus::RefundRequested {
            return Err(ContractError::RefundNotRequested);
        }
        let grace_window: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::GraceWindow)
            .unwrap();
        let release_at = invoice
            .created_at
            .checked_add(grace_window)
            .ok_or(ContractError::Overflow)?;
        if env.ledger().timestamp() < release_at {
            return Err(ContractError::GraceWindowNotExpired);
        }
        invoice.status = InvoiceStatus::Released;
        env.storage()
            .persistent()
            .set(&DataKey::Invoice(invoice_id), &invoice);
        events::escrow_released(&env, &invoice_id);
        Ok(())
    }

    /// Expires a batch of `Pending` invoices whose `expires_at` timestamp has passed.
    ///
    /// Invoices that are not `Pending` or have not yet expired are silently skipped,
    /// so this function is safe to call with a broad set of IDs.
    ///
    /// # Parameters
    /// - `invoice_ids`: A vector of invoice IDs to check and potentially expire.
    ///
    /// # Errors
    /// - [`ContractError::ContractPaused`] if the contract is currently paused.
    /// - [`ContractError::InvoiceNotFound`] if any ID in the batch does not exist.
    ///
    /// # Events
    /// Emits `invoice_expired(invoice_id)` for each invoice that transitions to `Expired`.
    pub fn batch_expire(env: Env, invoice_ids: Vec<u64>) -> Result<(), ContractError> {
        check_not_paused(&env)?;
        let now = env.ledger().timestamp();
        for id in invoice_ids.iter() {
            let mut invoice = env
                .storage()
                .persistent()
                .get::<DataKey, Invoice>(&DataKey::Invoice(id))
                .ok_or(ContractError::InvoiceNotFound)?;
            if invoice.status == InvoiceStatus::Pending && now >= invoice.expires_at {
                invoice.status = InvoiceStatus::Expired;
                env.storage()
                    .persistent()
                    .set(&DataKey::Invoice(id), &invoice);
                events::invoice_expired(&env, &id);
            }
        }
        Ok(())
    }

    /// Configure the treasury contract address (admin only).
    ///
    /// The treasury address is required before `raise_dispute`
    /// can be called. Cross-contract calls to the treasury use this stored address.
    ///
    /// # Parameters
    /// - `caller`: Must be the contract admin.
    /// - `treasury`: The address of the deployed treasury contract.
    ///
    /// # Errors
    /// - [`ContractError::Unauthorized`] if `caller` is not the admin.
    pub fn set_treasury(env: Env, caller: Address, treasury: Address) -> Result<(), ContractError> {
        check_not_paused(&env)?;
        check_admin(&env, &caller)?;
        env.storage()
            .persistent()
            .set(&DataKey::TreasuryContract, &treasury);
        Ok(())
    }

    /// Returns the currently configured treasury contract address, if any.
    ///
    /// Returns `None` if `set_treasury` has not been called yet.
    pub fn get_treasury(env: Env) -> Option<Address> {
        env.storage().persistent().get(&DataKey::TreasuryContract)
    }

    /// Raises a dispute on an invoice via a cross-contract call to the treasury.
    ///
    /// **Cross-contract call:** invokes `treasury.raise_dispute(claimant, settlement_id, reason)`.
    /// The treasury contract address must have been set via `set_treasury`.
    ///
    /// Requires `claimant` to authorise the call (`claimant.require_auth()`).
    ///
    /// # Parameters
    /// - `invoice_id`: The invoice the dispute relates to; must exist.
    /// - `settlement_id`: The ID of the settlement record in the treasury contract.
    /// - `claimant`: The address raising the dispute; must authorise the transaction.
    /// - `reason`: An opaque reason code interpreted by the treasury contract.
    ///
    /// # Errors
    /// - [`ContractError::ContractPaused`] if the contract is currently paused.
    /// - [`ContractError::InvoiceNotFound`] if no invoice with `invoice_id` exists.
    /// - [`ContractError::TreasuryNotConfigured`] if no treasury address has been set.
    ///
    /// # Events
    /// Emits `dispute_raised(invoice_id, settlement_id, claimant)` on success.
    pub fn raise_dispute(
        env: Env,
        invoice_id: u64,
        settlement_id: u64,
        claimant: Address,
        reason: u32,
    ) -> Result<(), ContractError> {
        check_not_paused(&env)?;
        claimant.require_auth();

        let invoice = env
            .storage()
            .persistent()
            .get::<DataKey, Invoice>(&DataKey::Invoice(invoice_id))
            .ok_or(ContractError::InvoiceNotFound)?;
        if claimant != invoice.merchant && claimant != invoice.customer {
            return Err(ContractError::NotAParty);
        }

        let treasury: Address = env
            .storage()
            .persistent()
            .get(&DataKey::TreasuryContract)
            .ok_or(ContractError::TreasuryNotConfigured)?;

        // Cross-contract: treasury.raise_dispute(claimant, settlement_id, reason)
        let _: () = env.invoke_contract(
            &treasury,
            &Symbol::new(&env, "raise_dispute"),
            soroban_sdk::vec![
                &env,
                claimant.clone().into_val(&env),
                settlement_id.into_val(&env),
                reason.into_val(&env),
            ],
        );

        events::dispute_raised(&env, &invoice_id, &settlement_id, &claimant);
        Ok(())
    }

    /// Pauses the contract, blocking all mutating operations until `unpause`
    /// is called. Admin-only.
    ///
    /// # Parameters
    /// - `caller`: Must be the contract admin.
    ///
    /// # Errors
    /// - [`ContractError::Unauthorized`] if `caller` is not the admin.
    ///
    /// # Events
    /// Emits `contract_paused()` on success.
    pub fn pause(env: Env, caller: Address) -> Result<(), ContractError> {
        check_admin(&env, &caller)?;
        env.storage().persistent().set(&DataKey::Paused, &true);
        events::contract_paused(&env);
        Ok(())
    }

    /// Unpauses the contract, restoring all mutating operations. Admin-only.
    ///
    /// # Parameters
    /// - `caller`: Must be the contract admin.
    ///
    /// # Errors
    /// - [`ContractError::Unauthorized`] if `caller` is not the admin.
    ///
    /// # Events
    /// Emits `contract_unpaused()` on success.
    pub fn unpause(env: Env, caller: Address) -> Result<(), ContractError> {
        check_admin(&env, &caller)?;
        env.storage().persistent().set(&DataKey::Paused, &false);
        events::contract_unpaused(&env);
        Ok(())
    }

    /// Sets the grace window duration used by `release_escrow`.
    /// Admin-only. The contract must not be paused.
    ///
    /// # Parameters
    /// - `caller`: Must be the contract admin.
    /// - `window`: Grace window in seconds measured from `invoice.created_at`.
    ///   Defaults to 86 400 (24 h) on initialisation.
    ///
    /// # Errors
    /// - [`ContractError::ContractPaused`] if the contract is currently paused.
    /// - [`ContractError::Unauthorized`] if `caller` is not the admin.
    pub fn set_grace_window(env: Env, caller: Address, window: u64) -> Result<(), ContractError> {
        check_not_paused(&env)?;
        check_admin(&env, &caller)?;
        env.storage()
            .persistent()
            .set(&DataKey::GraceWindow, &window);
        Ok(())
    }

    /// Returns the currently configured grace window in seconds.
    ///
    /// Falls back to 86 400 (24 h) if the value has never been written (e.g. before
    /// `initialize` is called).
    pub fn get_grace_window(env: Env) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::GraceWindow)
            .unwrap_or(86400)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::Env;

    fn setup_contract(ts: u64) -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(InvoiceContract, ());
        InvoiceContractClient::new(&env, &contract_id).initialize(&admin);
        env.ledger().with_mut(|li| li.timestamp = ts);
        (env, contract_id, admin)
    }

    #[test]
    fn test_create_invoice_with_unique_nonce_succeeds() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let merchant = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);
        let invoice_id = client.create_invoice(&merchant, &customer, &1000i128, &token, &5000, &1);
        assert_eq!(invoice_id, 1);
    }

    #[test]
    fn test_create_invoice_with_duplicate_nonce_returns_error() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let merchant = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);

        client.create_invoice(&merchant, &customer, &1000i128, &token, &5000, &1);

        let result = client.try_create_invoice(&merchant, &customer, &1000i128, &token, &5000, &1);
        assert_eq!(result, Err(Ok(ContractError::DuplicateNonce)));
    }

    #[test]
    fn test_set_grace_window_when_paused_returns_contract_paused() {
        let (env, cid, admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        client.pause(&admin);
        let res = client.try_set_grace_window(&admin, &3600u64);
        assert_eq!(res, Err(Ok(ContractError::ContractPaused)));
    }

    #[test]
    fn test_different_merchants_can_reuse_same_nonce() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let merchant_a = Address::generate(&env);
        let merchant_b = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);

        client.create_invoice(&merchant_a, &customer, &1000i128, &token, &5000, &1);
        client.create_invoice(&merchant_b, &customer, &1000i128, &token, &5000, &1);

        let invoice_a = client.get_invoice(&1);
        let invoice_b = client.get_invoice(&2);
        assert_eq!(invoice_a.merchant, merchant_a);
        assert_eq!(invoice_b.merchant, merchant_b);
    }

    #[test]
    fn test_pause_blocks_create_invoice() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let merchant = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);
        env.ledger().set_timestamp(1000);

        let contract_id = env.register(InvoiceContract, ());
        let client = InvoiceContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        client.pause(&admin);

        let result = client.try_create_invoice(&merchant, &customer, &1000i128, &token, &5000, &1);
        assert_eq!(result, Err(Ok(ContractError::ContractPaused)));
    }

    #[test]
    fn test_create_invoice_near_u64_max_count_returns_overflow() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(InvoiceContract, ());
        let client = InvoiceContractClient::new(&env, &contract_id);
        client.initialize(&admin);
        env.storage()
            .persistent()
            .set(&DataKey::InvoiceCount, &u64::MAX);

        let merchant = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);
        let result = client.try_create_invoice(&merchant, &customer, &1000i128, &token, &5000, &1);
        assert_eq!(result, Err(Ok(ContractError::Overflow)));
    }

    #[test]
    fn test_release_escrow_overflow_returns_error() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(InvoiceContract, ());
        let client = InvoiceContractClient::new(&env, &contract_id);
        client.initialize(&admin);
        env.ledger().with_mut(|li| li.timestamp = u64::MAX - 1);

        let merchant = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);
        let invoice_id = client.create_invoice(&merchant, &customer, &1000i128, &token, &5000, &1);
        client.mark_paids(&soroban_sdk::vec![&env, invoice_id]);
        client.request_refund(&invoice_id, &customer);
        let result = client.try_release_escrow(&invoice_id, &merchant);
        assert_eq!(result, Err(Ok(ContractError::Overflow)));
    }

    #[test]
    fn test_unpause_restores_create_invoice() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let merchant = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);
        env.ledger().set_timestamp(1000);

        let contract_id = env.register(InvoiceContract, ());
        let client = InvoiceContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        client.pause(&admin);
        let result = client.try_create_invoice(&merchant, &customer, &1000i128, &token, &5000, &1);
        assert_eq!(result, Err(Ok(ContractError::ContractPaused)));

        client.unpause(&admin);
        let invoice_id = client.create_invoice(&merchant, &customer, &1000i128, &token, &5000, &2);
        assert_eq!(invoice_id, 1);
    }

    #[test]
    fn test_pause_unauthorized() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);

        let contract_id = env.register(InvoiceContract, ());
        let client = InvoiceContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        let result = client.try_pause(&non_admin);
        assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
    }

    #[test]
    fn test_unpause_unauthorized() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);

        let contract_id = env.register(InvoiceContract, ());
        let client = InvoiceContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        client.pause(&admin);

        let result = client.try_unpause(&non_admin);
        assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
    }

    // ── raise_dispute integration tests ─────────────────────────────────────

    mod treasury_stub {
        use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env};

        #[contracterror]
        #[derive(Copy, Clone, Debug, Eq, PartialEq)]
        pub enum StubError {
            Paused = 1,
        }

        #[contracttype]
        pub enum StubKey {
            Held(u64),
        }

        #[contract]
        pub struct TreasuryStub;

        #[contractimpl]
        impl TreasuryStub {
            pub fn raise_dispute(
                e: Env,
                _signer: Address,
                settlement_id: u64,
                _reason: u32,
            ) -> Result<(), StubError> {
                e.storage()
                    .instance()
                    .set(&StubKey::Held(settlement_id), &true);
                Ok(())
            }

            pub fn was_held(e: Env, settlement_id: u64) -> bool {
                e.storage()
                    .instance()
                    .get(&StubKey::Held(settlement_id))
                    .unwrap_or(false)
            }
        }
    }

    use treasury_stub::{TreasuryStub, TreasuryStubClient};

    fn setup_with_treasury(ts: u64) -> (Env, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let invoice_cid = env.register(InvoiceContract, ());
        let treasury_cid = env.register(TreasuryStub, ());
        let invoice_client = InvoiceContractClient::new(&env, &invoice_cid);
        invoice_client.initialize(&admin);
        invoice_client.set_treasury(&admin, &treasury_cid);
        env.ledger().with_mut(|li| li.timestamp = ts);
        (
            env,
            invoice_cid,
            treasury_cid,
            admin,
            Address::generate(&env),
        )
    }

    #[test]
    fn test_raise_dispute_places_settlement_on_hold() {
        let (env, invoice_cid, treasury_cid, _admin, _claimant) = setup_with_treasury(1000);
        let invoice_client = InvoiceContractClient::new(&env, &invoice_cid);
        let treasury_client = TreasuryStubClient::new(&env, &treasury_cid);

        let merchant = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);
        let invoice_id =
            invoice_client.create_invoice(&merchant, &customer, &1000i128, &token, &9999, &1);

        invoice_client.raise_dispute(&invoice_id, &1u64, &merchant, &1u32);

        assert!(
            treasury_client.was_held(&1u64),
            "settlement should be on hold"
        );
    }

    #[test]
    fn test_raise_dispute_emits_event() {
        let (env, invoice_cid, _treasury_cid, _admin, _claimant) = setup_with_treasury(1000);
        let invoice_client = InvoiceContractClient::new(&env, &invoice_cid);

        let merchant = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);
        let invoice_id =
            invoice_client.create_invoice(&merchant, &customer, &500i128, &token, &9999, &1);

        invoice_client.raise_dispute(&invoice_id, &2u64, &merchant, &1u32);

        // invoice_created + dispute_raised = at least 2 events
        let all_events = env.events().all();
        assert!(
            all_events.len() >= 2,
            "dispute_raised event should be emitted"
        );
    }

    #[test]
    fn test_raise_dispute_invoice_not_found_fails() {
        let (env, invoice_cid, _treasury_cid, _admin, claimant) = setup_with_treasury(1000);
        let invoice_client = InvoiceContractClient::new(&env, &invoice_cid);

        let result = invoice_client.try_raise_dispute(&999u64, &1u64, &claimant, &1u32);
        assert_eq!(result, Err(Ok(ContractError::InvoiceNotFound)));
    }

    #[test]
    fn test_raise_dispute_without_treasury_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let invoice_cid = env.register(InvoiceContract, ());
        let invoice_client = InvoiceContractClient::new(&env, &invoice_cid);
        invoice_client.initialize(&admin);
        env.ledger().with_mut(|li| li.timestamp = 1000);

        let merchant = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);
        let claimant = Address::generate(&env);
        let invoice_id =
            invoice_client.create_invoice(&merchant, &customer, &100i128, &token, &9999, &1);

        let result = invoice_client.try_raise_dispute(&invoice_id, &1u64, &claimant, &1u32);
        assert_eq!(result, Err(Ok(ContractError::TreasuryNotConfigured)));
    }

    #[test]
    fn test_raise_dispute_when_paused_fails() {
        let (env, invoice_cid, _treasury_cid, admin, claimant) = setup_with_treasury(1000);
        let invoice_client = InvoiceContractClient::new(&env, &invoice_cid);

        let merchant = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);
        let invoice_id =
            invoice_client.create_invoice(&merchant, &customer, &100i128, &token, &9999, &1);

        invoice_client.pause(&admin);

        let result = invoice_client.try_raise_dispute(&invoice_id, &1u64, &claimant, &1u32);
        assert_eq!(result, Err(Ok(ContractError::ContractPaused)));
    }

    // ── cancellation refund-path tests ───────────────────────────────────────

    fn create_test_invoice(
        client: &InvoiceContractClient,
        env: &Env,
    ) -> (Address, Address, u64) {
        let merchant = Address::generate(env);
        let customer = Address::generate(env);
        let token = Address::generate(env);
        let id = client.create_invoice(&merchant, &customer, &1_000_000i128, &token, &9999, &1);
        (merchant, customer, id)
    }

    /// Cancelling a Pending invoice (no funds moved) succeeds and sets Cancelled.
    /// Both merchant and customer are authorised to cancel.
    #[test]
    fn test_cancel_pending_invoice_no_fund_movement() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let (merchant, _customer, id) = create_test_invoice(&client, &env);

        client.cancel_invoiced(&id, &merchant);

        let invoice = client.get_invoice(&id);
        assert_eq!(invoice.status, InvoiceStatus::Cancelled);
    }

    /// Customer can also cancel a Pending invoice.
    #[test]
    fn test_cancel_pending_invoice_by_customer_succeeds() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let (_merchant, customer, id) = create_test_invoice(&client, &env);

        client.cancel_invoiced(&id, &customer);

        let invoice = client.get_invoice(&id);
        assert_eq!(invoice.status, InvoiceStatus::Cancelled);
    }

    /// Cancelling a Paid invoice initiates the refund path (→ RefundRequested).
    /// Ensures funds are not left stuck with no valid state transition.
    #[test]
    fn test_cancel_paid_invoice_transitions_to_refund_requested() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let (merchant, _customer, id) = create_test_invoice(&client, &env);

        // Pay the invoice (funds are now escrowed).
        client.mark_paids(&soroban_sdk::vec![&env, id]);
        let after_pay = client.get_invoice(&id);
        assert_eq!(after_pay.status, InvoiceStatus::Paid);

        // Merchant cancels — must open the refund path, not leave funds stuck.
        client.cancel_invoiced(&id, &merchant);

        let after_cancel = client.get_invoice(&id);
        assert_eq!(
            after_cancel.status,
            InvoiceStatus::RefundRequested,
            "cancelling a paid invoice must initiate the refund path"
        );
    }

    /// Cancelling an invoice where a refund is already in progress returns
    /// AlreadyRefundRequested.
    #[test]
    fn test_cancel_refund_requested_invoice_returns_already_refund_requested() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let (merchant, _customer, id) = create_test_invoice(&client, &env);

        client.mark_paids(&soroban_sdk::vec![&env, id]);
        // First cancel: opens refund path.
        client.cancel_invoiced(&id, &merchant);
        // Second cancel: refund already in progress.
        let res = client.try_cancel_invoiced(&id, &merchant);
        assert_eq!(res, Err(Ok(ContractError::AlreadyRefundRequested)));
    }

    /// Cancelling an already-Cancelled invoice returns InvoiceCancelled (terminal state).
    #[test]
    fn test_cancel_already_cancelled_invoice_returns_invoice_cancelled() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let (merchant, _customer, id) = create_test_invoice(&client, &env);

        client.cancel_invoiced(&id, &merchant);
        let res = client.try_cancel_invoiced(&id, &merchant);
        assert_eq!(res, Err(Ok(ContractError::InvoiceCancelled)));
    }

    /// A stranger (neither merchant nor customer) cannot cancel an invoice.
    #[test]
    fn test_cancel_by_stranger_returns_unauthorized() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let (_merchant, _customer, id) = create_test_invoice(&client, &env);
        let stranger = Address::generate(&env);

        let res = client.try_cancel_invoiced(&id, &stranger);
        assert_eq!(res, Err(Ok(ContractError::Unauthorized)));
    }

    /// Cancelling a non-existent invoice returns InvoiceNotFound.
    #[test]
    fn test_cancel_nonexistent_invoice_returns_not_found() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let caller = Address::generate(&env);

        let res = client.try_cancel_invoiced(&9999u64, &caller);
        assert_eq!(res, Err(Ok(ContractError::InvoiceNotFound)));
    }

    /// Cancelling when the contract is paused returns ContractPaused.
    #[test]
    fn test_cancel_when_paused_returns_contract_paused() {
        let (env, cid, admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let (merchant, _customer, id) = create_test_invoice(&client, &env);

        client.pause(&admin);
        let res = client.try_cancel_invoiced(&id, &merchant);
        assert_eq!(res, Err(Ok(ContractError::ContractPaused)));
    }
}
