# Error Codes

This document maps every `InvoiceError`, `ContractError`, `SettlementError`, and `TreasuryError` variant (and other contract error codes) to its numeric value, the condition that triggers it, and the recommended remediation steps for integrators.

> Cross-reference: see [docs/api-reference.md](./api-reference.md) for HTTP-level error shapes returned by the backend.

---

## InvoiceError

Defined in `contracts/invoice/src/lib.rs`. The `COMEBACKHERE-contracts/contracts/invoice` crate declares a related enum called `ContractError (invoice)` (see below) — variant names overlap but numeric codes are independent.

| Code | Name | Trigger condition | Remediation |
| ------ | ------ | ------------------- | ------------- |
| 1 | `Unauthorized` | Caller is not the merchant, admin, or payer for the operation. | Ensure the signing key matches the expected role. Merchants must sign `create_invoice`; the admin must sign `mark_paid` / `release_escrow`; the payer must sign `request_refund`. |
| 2 | `ContractPaused` | A state-changing call was made while the contract is in a paused state. | Check contract status before submitting. Contact the admin to unpause the contract. Do not retry until the contract is unpaused. |
| 3 | `InvalidAmount` | `amount_usdc` ≤ 0, or `gross_usdc` < `amount_usdc`. | Verify that both amounts are positive and that `gross_usdc ≥ amount_usdc`. Amounts are denominated in USDC stroops (1 USDC = 10 000 000 stroops). |
| 4 | `NotPending` | An operation that requires `Pending` status (e.g. `mark_paid`, `cancel`) was called on an invoice in another state. | Fetch the current invoice status before acting. If the invoice has already been paid, expired, or cancelled, no further action is needed. |
| 5 | `Expired` | Payment was attempted after the invoice's `expires_at` timestamp. | Create a new invoice with a future `expires_in_seconds`. Do not attempt to pay an invoice that has already expired. |
| 6 | `NotFound` | No invoice exists for the supplied ID. | Confirm the invoice ID with the merchant. IDs are sequential `u64` values returned by `create_invoice`. |
| 7 | `AlreadyInitialized` | `initialize` was called on a contract that is already set up. | This is a deployment-time error. Remove the extra `initialize` call; the contract can only be initialised once. |
| 8 | `ZeroDuration` | `expires_in_seconds` was 0 on invoice creation. | Pass a positive duration. Typical values are 3 600 (1 hour) to 2 592 000 (30 days). |
| 9 | `ExpiryOverflow` | `ledger_timestamp + expires_in_seconds` overflows `u64`. | Reduce the expiry duration. Any duration that would place the expiry beyond year 2554 will overflow. |
| 10 | `NotPaid` | `request_refund` or `release_escrow` was called on an invoice that is not in `Paid` status. | Confirm the invoice status is `Paid` before requesting a refund or releasing escrow. |
| 12 | `AmountPrecision` | Amount is below the minimum of 1 USDC (10 000 000 stroops). | Set `amount_usdc` ≥ 10 000 000. Fractional-USDC invoices are not supported. |
| 13 | `DuplicateNonce` | A merchant nonce has already been used for a previous invoice. | Generate a fresh nonce for each invoice. Reusing a nonce is rejected to prevent replay attacks. |

---

## ContractError (invoice)

Defined in `COMEBACKHERE-contracts/contracts/invoice/src/lib.rs`. Shares some variant names with `InvoiceError` above, but numeric codes and semantic triggers are independent — branch on the enum name when integrating.

| Code | Name | Trigger condition | Remediation |
| ------ | ------ | ------------------- | ------------- |
| 1 | `Unauthorized` | Caller is neither the merchant nor the customer for the operation. | Sign with the merchant key for cancellation flows or with the customer key for refund flows. The admin key is required for `pause`, `unpause`, `set_treasury`, and `set_grace_window`. |
| 2 | `ContractPaused` | A state-changing call was made while the contract is in a paused state. | Check contract status before submitting. Contact the admin to unpause. Do not retry until the contract is unpaused. |
| 3 | `AlreadyInitialized` | `initialize` was called on a contract that is already set up. | Deployment-time error. Remove the extra initialize call; the contract can only be initialised once. |
| 4 | `InvoiceNotFound` | `get_invoice`, `cancel_invoiced`, `mark_paids`, `request_refund`, `release_escrow`, or `raise_dispute` was called with an ID that does not exist. | Confirm the invoice ID returned by `create_invoice`. |
| 5 | `InvoiceAlreadyPaid` | `mark_paids` was called on an invoice that is no longer in `Pending` status. | Inspect invoice status with `get_invoice_status` before marking paid. Already-paid invoices cannot transition again. |
| 6 | `InvoiceExpired` | `mark_paids` was called after `env.ledger().timestamp() >= invoice.expires_at`. | Pay invoices before the configured expiry. Use `batch_expire` to sweep stale invoices off the books. |
| 7 | `InvoiceCancelled` | `cancel_invoiced` was called on a non-Pending invoice. | Invoices can only be cancelled while `Pending`. Confirm status before cancelling. |
| 8 | `NotMerchant` | `release_escrow` was called by a non-merchant caller. | Sign with the merchant key associated with the invoice to release escrow. |
| 9 | `NotCustomer` | `request_refund` was called by a non-customer caller. | Sign with the customer key associated with the invoice to request a refund. |
| 10 | `RefundNotRequested` | `release_escrow` was called before `request_refund` moved the invoice to `RefundRequested`. | Call `request_refund` first, then wait for the grace window to elapse before `release_escrow`. |
| 11 | `AlreadyRefundRequested` | `request_refund` was called on an invoice that is already in `RefundRequested` status. | Each invoice may transition to `RefundRequested` only once. Inspect status before re-requesting. |
| 12 | `GraceWindowNotExpired` | `release_escrow` was called before `created_at + grace_window`. | Wait until `ledger.timestamp() >= created_at + grace_window`. Admin may reduce `GraceWindow` via `set_grace_window` (default 86 400 seconds). |
| 13 | `DuplicateNonce` | The (merchant, nonce) pair has already been used by a previous invoice. | Generate a fresh nonce for each invoice. Different merchants may reuse the same nonce value without collision. |
| 14 | `TreasuryNotConfigured` | `raise_dispute` was called before the admin ran `set_treasury`. | Admin must call `set_treasury` once before disputes can be raised. |

---

## ContractError (compliance)

Defined in `COMEBACKHERE-contracts/contracts/compliance/src/lib.rs`.

| Code | Name | Trigger condition | Remediation |
| ------ | ------ | ------------------- | ------------- |
| 1 | `Unauthorized` | Caller is not the admin configured in `initialize`. | Sign with the admin key for state-changing calls (`set_status`, `pause`, `unpause`, admin rotation). |
| 2 | `ContractPaused` | A state-changing call was made while the compliance contract is paused. | Compliance check calls return early on pause; defer the user action or have the admin unpause. |
| 3 | `AlreadyInitialized` | `initialize` was called on a contract that is already set up. | Deployment-time error. The compliance contract can only be initialised once. |
| 4 | `AddressNotFound` | A status query (or block/unblock flow) referenced an address that has not been recorded in `Status(Address)`. | Register the address via `set_status` first, or use the `Cleared` default if no entry exists. |

---

## SettlementError

Defined in `contracts/settlement/src/lib.rs`.

| Code | Name | Trigger condition | Remediation |
| ------ | ------ | ------------------- | ------------- |
| 1 | `NotFound` | No settlement exists for the supplied ID. | Confirm the settlement ID returned by `propose`. |
| 2 | `Unauthorized` | Caller has no registered weight in the treasury signer set. | Use a key that was registered via `initialize` or a subsequent signer-rotation call. |
| 3 | `AlreadyApproved` | The same signer attempted to approve the same settlement twice. | Each signer may approve a settlement only once. |
| 4 | `NotPending` | `approve_settlement` or `cancel` was called on a settlement that is not in `Pending` status. | Check the settlement status before calling approve or cancel. |
| 5 | `DuplicateSigner` | `initialize` was called with the same signer address appearing more than once in the `signers` list. | Ensure every `(address, weight)` pair in the `signers` vector is unique before calling `initialize`. |
| 6 | `InvalidWeightSum` | `initialize` was called with a `threshold` greater than the sum of all signer weights. | Lower the threshold or add signers with sufficient weight so that `sum(weights) ≥ threshold`. |

---

## TreasuryError

Defined in `COMEBACKHERE-contracts/contracts/treasury/src/lib.rs`.

| Code | Name | Trigger condition | Remediation |
| ------ | ------ | ------------------- | ------------- |
| 1 | `ContractPaused` | A state-changing call was made while the treasury is in a paused state. | Defer transactions until the admin runs `unpause`. |
| 2 | `NotPending` | `approve_settlement` or `execute_settlement` was called on a settlement that is not in `Pending` status. | Confirm pending status with `get_pending_settlements` before approving or executing. |
| 3 | `InsufficientApprovals` | `execute_settlement` was called before accumulated signer weight reached the configured threshold. | Continue gathering approvals until `approval_weight ≥ threshold`, then call `execute_settlement`. |
| 4 | `TokenNotAllowed` | `propose_settlement` was called with a token not present in the allowlist (when the allowlist is non-empty). | Admin must call `add_token_to_allowlist` for the token before settlements may be proposed against it. |
| 5 | `Unauthorized` | Caller is not registered as a signer (for `propose_settlement`/`approve_settlement`) or not the admin (for `set_signer`, `pause`, etc). | Use a key registered via `initialize` or `set_signer`; admin-only operations require the admin key. |
| 6 | `InvalidThreshold` | `update_threshold` was called with a threshold of 0. | Pass a positive `u32` threshold; the multi-sig cannot function with zero required weight. |
| 7 | `DuplicateSigner` | `initialize` was called with the same signer address appearing more than once in the `signers` list. | Ensure every `(address, weight)` pair in the `signers` vector is unique before calling `initialize`. |
| 8 | `InvalidWeightSum` | `initialize` was called with a `threshold` greater than the sum of all signer weights. | Lower the threshold or add signers with sufficient weight so that `sum(weights) ≥ threshold`. |

---

## Error shape in API responses

Backend endpoints return errors as JSON:

```json
{
  "error": "Human-readable message",
  "code": 6
}
```

`code` corresponds directly to the numeric values in the tables above. When `code` is `null` or absent the error originates from the RPC layer rather than the contract.

---

## Quick-reference: HTTP status mapping

| HTTP status | Typical contract code(s) | Meaning |
| ------------- | -------------------------- | --------- |
| 400 | — | Invalid request body (validation failed before hitting the contract). |
| 403 | 1 (`Unauthorized`) | Caller is not authorised for the operation. |
| 404 | 6 (`NotFound`), 4 (`InvoiceNotFound`/`AddressNotFound`), Settlement 1 | Resource does not exist. |
| 422 | 3, 4, 5, 8, 9, 10, 12, 13 | Contract rejected the transaction. |
| 422 | Settlement 5 (`DuplicateSigner`), Settlement 6 (`InvalidWeightSum`) | `SettlementContract.initialize` called with duplicate signers or total weight below threshold. |
| 422 | Treasury 7 (`DuplicateSigner`), Treasury 8 (`InvalidWeightSum`) | `TreasuryContract.initialize` called with duplicate signers or total weight below threshold. |
| 503 | — | Backend misconfiguration (missing env vars). |
| 504 | — | Transaction confirmation timeout waiting for Soroban. |
