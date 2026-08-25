# API Reference

Base URL: `http://localhost:3000` (local) or your deployed backend.

All request bodies are JSON (`Content-Type: application/json`).
All responses are JSON.

> **Machine-readable spec:** A Swagger/OpenAPI 3.0 spec is served at
> [`GET /api-docs/swagger.json`](http://localhost:3000/api-docs/swagger.json) (raw JSON)
> and [`GET /api-docs`](http://localhost:3000/api-docs) (interactive Swagger UI).

---

## Health

### `GET /health`

Returns service health status.

**Response `200`**

```json
{ "status": "ok" }
```

---

### `GET /health/rpc`

Checks Soroban RPC reachability and current ledger.

**Response `200`**

```json
{
  "rpc": "reachable",
  "network": "mainnet",
  "ledger": 54321678
}
```

#### Errors

| Status | Description                             |
| ------ | --------------------------------------- |
| `503`  | Soroban RPC unreachable                 |
| `500`  | Unexpected server error                 |

---


## Invoices

### `GET /invoices/:id`

Fetch the on-chain status of an invoice by its numeric ID.

#### Path parameters

| Parameter | Type   | Description             |
| --------- | ------ | ----------------------- |
| `id`      | string | Positive integer string |

**Response `200`**

```json
{
  "invoice_id": "42",
  "status": "Pending"
}
```

#### Errors

| Status | Description                              |
| ------ | ---------------------------------------- |
| `400`  | `id` is not a positive integer           |
| `404`  | Invoice not found on-chain               |
| `503`  | Missing required environment variables   |
| `500`  | Unexpected server error                  |

---

### `POST /invoices`

Create a new invoice by submitting `create_invoice` to the Soroban RPC.

#### Request body

```json
{
  "merchant_address": "G...",
  "token": "USDC",
  "amount": 1000000,
  "due_date": 1720000000
}
```

| Field              | Type   | Description                                       |
| ------------------ | ------ | ------------------------------------------------- |
| `merchant_address` | string | Valid Stellar public key (G…)                    |
| `token`            | string | Token identifier                                  |
| `amount`           | number | Positive number (in stroops / smallest unit)      |
| `due_date`         | number | Future Unix timestamp (seconds) for the due date  |

**Response `201`**

```json
{
  "invoice_id": "1",
  "status": "Pending"
}
```

#### Errors

| Status | Description                                                    |
| ------ | -------------------------------------------------------------- |
| `400`  | Validation error — see `error` field for detail                |
| `422`  | Soroban simulation or transaction failure                      |
| `503`  | Missing required environment variables                         |
| `504`  | Transaction confirmation timeout                               |
| `500`  | Unexpected server error                                        |

---

## Disputes

### `POST /disputes`

Raise a dispute linked to a settlement, transitioning it to `OnHold`.

#### Request body

```json
{
  "claimant_address": "G...",
  "settlement_id": "5",
  "reason": "Goods not delivered"
}
```

| Field               | Type   | Required | Description                                      |
| ------------------- | ------ | -------- | ------------------------------------------------ |
| `claimant_address`  | string | Yes      | Valid Stellar public key of the disputing party  |
| `settlement_id`     | string | Yes      | Positive integer string identifying settlement   |
| `reason`            | string | No       | Human-readable reason for the dispute            |

**Response `201`**

```json
{
  "dispute_id": "5-1720000000000",
  "settlement_id": "5",
  "claimant_address": "G...",
  "status": "Raised",
  "settlement_status": "OnHold"
}
```

#### Errors

| Status | Description                                                    |
| ------ | -------------------------------------------------------------- |
| `400`  | Validation error — see `error` field for detail                |
| `503`  | Missing required environment variables                         |
| `500`  | Unexpected server error                                        |

---

## Treasury

### `GET /api/treasury/pending-settlements`

Returns all settlements with `Pending` status from the indexed database.

**Response `200`**

```json
[
  {
    "id": 1,
    "merchant_address": "G...",
    "amount": "5000000",
    "approvals": ["G..."],
    "approval_weight": 1,
    "status": "Pending",
    "hold_reason": null
  }
]
```

#### Errors

| Status | Description             |
| ------ | ----------------------- |
| `500`  | Database error          |

---

### `POST /api/treasury/approve-settlement`

Approve a pending settlement by submitting `approve_settlement` to the treasury contract.

#### Request body

```json
{ "settlement_id": 1 }
```

| Field           | Type   | Description                    |
| --------------- | ------ | ------------------------------ |
| `settlement_id` | number | Positive integer settlement ID |

**Response `200`**

```json
{
  "id": 1,
  "merchant_address": "G...",
  "amount": "5000000",
  "approvals": ["G..."],
  "approval_weight": 2,
  "status": "Pending",
  "hold_reason": null,
  "tx_hash": "abc123..."
}
```

#### Errors

| Status | Description                                     |
| ------ | ----------------------------------------------- |
| `400`  | `settlement_id` is not a positive integer        |
| `503`  | Missing required environment variables           |
| `500`  | Unexpected server error                          |

---

### `POST /api/treasury/execute-settlement`

Execute a fully-approved settlement after verifying the treasury USDC balance.

#### Request body

```json
{
  "settlement_id": 1,
  "token_contract": "C..."
}
```

| Field            | Type   | Required | Description                                                      |
| ---------------- | ------ | -------- | ---------------------------------------------------------------- |
| `settlement_id`  | number | Yes      | Positive integer settlement ID                                   |
| `token_contract` | string | No       | Token contract address — defaults to `USDC_CONTRACT_ID` env var |

**Response `200`**

```json
{
  "tx_hash": "abc123...",
  "settlement_id": 1,
  "balance_checked": "10000000",
  "amount_required": "5000000"
}
```

#### Errors

| Status | Description                                        |
| ------ | -------------------------------------------------- |
| `400`  | `settlement_id` is not a positive integer           |
| `409`  | Settlement is not in `Pending` status               |
| `422`  | Insufficient treasury balance or simulation failure |
| `503`  | Missing required environment variables              |
| `500`  | Unexpected server error                             |

---

### `GET /api/treasury/threshold`

Returns the current approval threshold from the treasury contract.

**Response `200`**

```json
{ "threshold": 2 }
```

#### Errors

| Status | Description                             |
| ------ | --------------------------------------- |
| `422`  | Soroban simulation failure              |
| `503`  | Missing required environment variables  |
| `500`  | Unexpected server error                 |

---

### `POST /api/treasury/threshold`

Update the treasury approval threshold.

#### Request body

```json
{ "threshold": 3 }
```

| Field       | Type   | Description                    |
| ----------- | ------ | ------------------------------ |
| `threshold` | number | Positive integer ≥ 1           |

**Response `200`**

```json
{
  "threshold": 3,
  "tx_hash": "abc123..."
}
```

#### Errors

| Status | Description                                     |
| ------ | ----------------------------------------------- |
| `400`  | `threshold` is not a positive integer            |
| `422`  | Soroban simulation or transaction failure        |
| `503`  | Missing required environment variables           |
| `500`  | Unexpected server error                          |

---

### `GET /api/treasury/on-hold-settlements`

Returns all settlements that are currently on hold.
A hold is placed when a signer flags a settlement as requiring manual review before
execution can proceed.

**Query parameters:**

| Parameter | Type   | Required | Description                                   |
|-----------|--------|----------|-----------------------------------------------|
| `page`    | number | No       | Page number (1-based, default: `1`)           |
| `limit`   | number | No       | Results per page (default: `20`, max: `100`)  |

**Response `200`**

```json
{
  "settlements": [
    {
      "id": 7,
      "merchant_address": "G...",
      "amount": "5000000",
      "approvals": [],
      "approval_weight": 0,
      "status": "OnHold",
      "hold_reason": "Merchant KYC under review"
    }
  ]
}
```

#### Errors

| Status | Description             |
| ------ | ----------------------- |
| `500`  | Database error          |

---

### `POST /api/treasury/release-hold`

Releases a held settlement, restoring it to `Pending` so the normal approval and
execution flow can resume. Calls `release_hold` on the treasury contract.

See also: [`release_hold` in the Contract Interaction Guide](./contract-interaction-guide.md#release-a-hold).

#### Request body

```json
{ "settlement_id": 7 }
```

| Field           | Type   | Description                    |
| --------------- | ------ | ------------------------------ |
| `settlement_id` | number | Positive integer settlement ID |

**Response `200`**

```json
{
  "id": 7,
  "merchant_address": "G...",
  "amount": "5000000",
  "approvals": [],
  "approval_weight": 0,
  "status": "Pending",
  "hold_reason": null,
  "tx_hash": "abc123..."
}
```

#### Errors

| Status | Description                                       |
| ------ | ------------------------------------------------- |
| `400`  | `settlement_id` is not a positive integer         |
| `409`  | Settlement is not currently on hold               |
| `422`  | Soroban simulation or transaction failure         |
| `503`  | Missing required environment variables            |
| `500`  | Unexpected server error                           |

---

### `POST /api/treasury/escalate-hold`

Escalates a held settlement to the on-chain dispute-resolution flow.
Calls `raise_dispute` on the treasury contract and begins a multi-sig governance
vote among the configured signers.

See also: [`raise_dispute` in the Contract Interaction Guide](./contract-interaction-guide.md#raise-a-dispute).

#### Request body

```json
{
  "settlement_id": 7,
  "reason": "Merchant disputes the invoice amount"
}
```

| Field           | Type   | Required | Description                                              |
| --------------- | ------ | -------- | -------------------------------------------------------- |
| `settlement_id` | number | Yes      | Positive integer settlement ID                           |
| `reason`        | string | No       | Human-readable reason for escalation (max 512 chars)     |

**Response `200`**

```json
{
  "dispute_id": "7-1720000001000",
  "settlement_id": "7",
  "status": "Raised",
  "settlement_status": "OnHold",
  "tx_hash": "abc123..."
}
```

#### Errors

| Status | Description                                       |
| ------ | ------------------------------------------------- |
| `400`  | `settlement_id` is not a positive integer         |
| `422`  | Soroban simulation or transaction failure         |
| `503`  | Missing required environment variables            |
| `500`  | Unexpected server error                           |

---


## Invoice Settings

### `GET /api/invoice/grace-window`

Returns the current invoice grace window in seconds.

**Response `200`**

```json
{ "grace_window_seconds": 86400 }
```

#### Errors

| Status | Description                             |
| ------ | --------------------------------------- |
| `422`  | Soroban simulation failure              |
| `503`  | Missing required environment variables  |
| `500`  | Unexpected server error                 |

---

### `POST /api/invoice/grace-window`

Update the invoice grace window.

#### Request body

```json
{ "grace_window_seconds": 172800 }
```

| Field                  | Type   | Description                           |
| ---------------------- | ------ | ------------------------------------- |
| `grace_window_seconds` | number | Positive integer number of seconds    |

**Response `200`**

```json
{
  "grace_window_seconds": 172800,
  "tx_hash": "abc123..."
}
```

#### Errors

| Status | Description                                     |
| ------ | ----------------------------------------------- |
| `400`  | `grace_window_seconds` is not a positive integer |
| `422`  | Soroban simulation or transaction failure        |
| `503`  | Missing required environment variables           |
| `500`  | Unexpected server error                          |

---

## Error response shape

All error responses share this shape:

```json
{ "error": "Human-readable description of the error." }
```

## Environment variables

| Variable               | Description                                               |
| ---------------------- | --------------------------------------------------------- |
| `SOROBAN_RPC_URL`      | Soroban RPC endpoint (e.g. `http://localhost:8000/soroban/rpc`) |
| `INVOICE_CONTRACT_ID`  | Deployed invoice contract address                         |
| `TREASURY_CONTRACT_ID` | Deployed treasury contract address                        |
| `USDC_CONTRACT_ID`     | USDC token contract address                               |
| `SETTLEMENT_CONTRACT_ID` | Settlement contract address (disputes)                  |
| `SIGNER_SECRET_KEY`    | Stellar secret key for signing transactions               |
| `NETWORK_PASSPHRASE`   | Stellar network passphrase                                |
| `PORT`                 | HTTP server port (default `3000`)                         |
