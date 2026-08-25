# COMEBACKHERE Soroban Mainnet Deployment

Mainnet deployment must not run from a single local shell. The checked-in `scripts/deploy_mainnet.sh` intentionally refuses to deploy because live deployment requires governance approval, multi-sig signing, and a recorded signing ceremony.

## Preconditions

- `cargo fmt --all -- --check` (in `COMEBACKHERE-contracts/`)
- `cargo clippy -- -D warnings` (in `COMEBACKHERE-contracts/`)
- `cargo test` (in `COMEBACKHERE-contracts/`)
- WASM artifacts built with `cargo build --target wasm32-unknown-unknown --release`
- Admin, treasury, and compliance keys confirmed on Stellar mainnet
- AWS KMS or approved signing service configured for production signing
- Production USDC asset issuer verified against official Circle/Stellar documentation
- Mainnet Horizon and Soroban RPC health checks passing

## Required Environment Variables

- `SOROBAN_RPC_URL` — Soroban RPC endpoint (e.g., `https://soroban-mainnet.stellar.org`)
- `SOROBAN_NETWORK_PASSPHRASE` — Network passphrase for mainnet signing
- `INVOICE_CONTRACT_ID` — Deployed invoice contract ID
- `TREASURY_CONTRACT_ID` — Deployed treasury contract ID
- `COMPLIANCE_CONTRACT_ID` — Deployed compliance contract ID

Set these via environment variables or in a `.env.mainnet` file. Scripts will fail fast if required variables are missing.

## Ceremony

1. Open a deployment issue with target commit SHA, expected WASM hashes, admins, and treasury signers.
2. Collect required multi-sig approvals.
3. Build release artifacts from a clean checkout of `COMEBACKHERE-contracts/`.
4. Verify WASM hashes match the deployment issue.
5. Submit deployment transactions through the approved signer.
6. Record transaction hashes and deployed contract IDs.
7. Deploy and initialize the compliance contract:
   - Deploy the compliance WASM to Soroban mainnet.
   - Call `initialize` with the protocol admin address.
   - Populate the initial allowlist with the admin, treasury signers, and any pre-approved merchants by calling `allow_address` for each.
   - Record the `COMPLIANCE_CONTRACT_ID` in the ceremony log.
8. Deploy and initialize the invoice contract:
   - Deploy the invoice WASM to Soroban mainnet.
   - Call `initialize` with the protocol admin address and the deployed compliance contract address.
   - Configure the grace window via `set_grace_window` if the default is not appropriate.
   - Record the `INVOICE_CONTRACT_ID` in the ceremony log.
9. Deploy and initialize the treasury contract:
   - Deploy the treasury WASM to Soroban mainnet.
   - Call `initialize` with the protocol admin address, the list of initial signers and their weights, and the required approval threshold.
   - Record the `TREASURY_CONTRACT_ID` in the ceremony log.
10. Update backend production secrets with:
    - `INVOICE_CONTRACT_ID`
    - `TREASURY_CONTRACT_ID`
    - `COMPLIANCE_CONTRACT_ID`
11. Run backend `GET /health/rpc` and a low-value end-to-end invoice payment smoke test.

## Compliance-Specific Admin Key Handling

- The compliance contract's admin keypair **must** be distinct from the invoice and treasury admin keypairs where possible to limit blast radius in the event of key compromise.
- The compliance admin key must be stored in a separate KMS key or hardware wallet from other contract admin keys.
- During signing ceremony, the compliance `initialize` and `allow_address` transactions should be signed and submitted **before** the invoice contract is initialized, because the invoice contract references the compliance contract at initialization time.

## Abort Conditions

- Any signer mismatch
- Any WASM hash mismatch
- Soroban RPC health degraded across all configured endpoints
- Compliance contract initialization fails or `is_allowed` returns unexpected results for the initial allowlist
- Any failed low-value payment smoke test

---

## Multi-Sig Governance Model

All mainnet contract deployments and administrative operations require approval
from multiple authorized signers. No single individual can unilaterally deploy,
upgrade, or modify mainnet contracts.

### Signer Roles

| Role | Count | Responsibility |
| ------ | ------- | ---------------- |
| **Lead Deployer** | 1 | Prepares the deployment issue, builds release artifacts, submits the deployment transaction after all approvals are collected. Does NOT hold sole signing authority. |
| **Security Reviewer** | 1–2 | Reviews the target commit for security vulnerabilities, verifies WASM hashes match the audited source, and signs off on the security checklist. |
| **Treasury Signer** | 2+ | Holds custody of treasury signing keys. Must independently verify artifact hashes before co-signing the deployment transaction. |
| **Compliance Officer** | 1 | Confirms that the deployment meets regulatory requirements, verifies that the compliance contract configuration is correct, and signs the compliance attestation. |
| **Ceremony Witness** | 1 | Observes the signing ceremony, records the audit log, and confirms that all procedural steps were followed. Does not hold a signing key. |

### Signing Threshold

The treasury contract enforces an on-chain multi-sig threshold. A deployment
transaction requires signatures meeting or exceeding the configured threshold
weight. The default configuration is:

- **Threshold**: 3 of 5 signers (by weight)
- **Each signer weight**: 1 (equal weight, adjustable via `update_threshold`)
- **Minimum signers for quorum**: 3

The threshold can only be changed through a signed `update_threshold` transaction
that itself meets the current threshold.

### Key Custody Requirements

1. **Hardware wallets required** — All mainnet signing keys MUST be stored on
   hardware wallets (Ledger Nano S/X or equivalent). Software-only keys are
   not permitted for mainnet operations.

2. **Geographic distribution** — Signing keys must be held by individuals in at
   least two distinct geographic locations to mitigate single-site risk.

3. **No shared custody** — Each signer holds exactly one key. No key may be
   shared between individuals or stored in a shared location (e.g., shared
   password manager vault).

4. **Backup and recovery** — Each signer must maintain a secure offline backup
   of their recovery seed phrase, stored separately from the hardware wallet
   itself. Recovery procedures must be tested at least once before participating
   in a mainnet ceremony.

5. **Key rotation schedule** — Signing keys should be rotated every 12 months
   or immediately upon any suspected compromise. Use the
   `propose_signer_rotation` and `approve_signer_rotation` contract functions
   to execute rotations on-chain.

6. **Revocation** — If a signer is compromised or departs the organization,
   their key must be removed via a signed `set_signer` transaction within 24
   hours. The remaining signers must meet quorum to execute this.

---

## Mainnet Signing Ceremony Checklist

The signing ceremony is a structured process that ensures every mainnet
deployment is safe, auditable, and authorized by the required signers.

### Pre-Ceremony (Lead Deployer, 24–48 hours before)

- [ ] Open a GitHub deployment issue using the deployment issue template
- [ ] Include the target commit SHA from `COMEBACKHERE-contracts/`
- [ ] Build WASM artifacts from a clean checkout of the target commit:

  ```sh
  git clone --branch <TAG> --depth 1 <REPO_URL>
  cd COMEBACKHERE-contracts/
  cargo build --target wasm32-unknown-unknown --release
  ```

- [ ] Compute and record SHA-256 hashes of all WASM artifacts:

  ```sh
  sha256sum target/wasm32-unknown-unknown/release/comebackhere_*.wasm
  ```

- [ ] Post the hashes in the deployment issue
- [ ] List the expected admin, treasury, and compliance public keys
- [ ] Tag all required signers for review
- [ ] Confirm Soroban mainnet RPC health:

  ```sh
  curl https://soroban-mainnet.stellar.org/health
  ```

### Security Review (Security Reviewer, before ceremony)

- [ ] Pull the exact commit SHA from the deployment issue
- [ ] Run static analysis and linting:

  ```sh
  cargo fmt --all -- --check
  cargo clippy -- -D warnings
  ```

- [ ] Run the full test suite:

  ```sh
  cargo test
  ```

- [ ] Review all contract changes since the last mainnet deployment
- [ ] Verify no new dependencies were introduced without review
- [ ] Independently build WASM artifacts and confirm hashes match the
      deployment issue
- [ ] Sign off on the deployment issue with a security approval comment

### Compliance Review (Compliance Officer, before ceremony)

- [ ] Verify that the compliance contract configuration matches the
      approved address allowlist
- [ ] Confirm no regulatory-sensitive changes were introduced
- [ ] Sign the compliance attestation in the deployment issue

### Ceremony Execution (All signers, synchronous)

All signers must be present (in-person or via authenticated video call) for the
ceremony. The Ceremony Witness records each step.

1. **Roll call** — Confirm identity of all participating signers. Record
   attendance in the ceremony log.

2. **Artifact verification** — Each signer independently verifies:
   - The deployment issue commit SHA matches the checked-out source
   - WASM hashes match the deployment issue
   - The security review and compliance attestation are present

3. **Environment confirmation** — The Lead Deployer confirms:
   - `SOROBAN_RPC_URL` points to mainnet (`https://soroban-mainnet.stellar.org`)
   - `SOROBAN_NETWORK_PASSPHRASE` is set to the mainnet passphrase
   - All required environment variables are set and verified

4. **Transaction construction** — The Lead Deployer constructs the deployment
   transaction(s) without submitting:

   ```sh
   stellar contract deploy \
     --wasm <WASM_PATH> \
     --network mainnet \
     --source <ADMIN_KEY> \
     --build-only
   ```

5. **Multi-sig collection** — Each Treasury Signer reviews the unsigned
   transaction and signs with their hardware wallet:
   - Verify the transaction destination, contract hash, and parameters
   - Sign using the hardware wallet
   - Pass the partial signature to the Lead Deployer

6. **Threshold verification** — The Lead Deployer confirms the collected
   signatures meet the on-chain threshold before submission.

7. **Submission** — The Lead Deployer submits the fully signed transaction to
   the Soroban RPC endpoint.

8. **Confirmation** — Wait for transaction confirmation. Record:
   - Transaction hash(es)
   - Deployed contract ID(s)
   - Ledger sequence number

9. **Post-deployment verification** — Run the following checks:
   - `GET /health/rpc` on the backend returns healthy
   - A low-value end-to-end invoice payment smoke test succeeds
   - Contract state queries return expected initial values

10. **Secret rotation** — Update backend production secrets with the new
    contract IDs:
    - `INVOICE_CONTRACT_ID`
    - `TREASURY_CONTRACT_ID`
    - `COMPLIANCE_CONTRACT_ID`

11. **Ceremony close** — The Ceremony Witness:
    - Records all transaction hashes in the deployment issue
    - Confirms all checklist items are complete
    - Closes the deployment issue with a summary comment

### Post-Ceremony (Lead Deployer, within 24 hours)

- [ ] Update `abis/` with the new contract metadata
- [ ] Open a PR to update ABI snapshots and any configuration references
- [ ] Notify the team in the designated channel that mainnet deployment is live
- [ ] Archive the ceremony recording (if video call) per retention policy

### Emergency Rollback

If a critical issue is discovered after deployment:

1. The Lead Deployer opens an emergency deployment issue
2. If the contracts support pause: execute `pause` via multi-sig to halt
   operations immediately
3. Follow the standard ceremony process for any corrective deployment
4. Document the incident in a post-mortem within 48 hours

---

## Upgrades and Migrations

Soroban supports in-place contract upgrades: the WASM bytecode is replaced
while the contract address, instance storage, and persistent storage remain
intact. No redeployment or re-initialization is needed. The upgrade mechanism
is a protocol-level host function — no proxy pattern is required.

All upgrades follow the same multi-sig governance process described in the
[Multi-Sig Governance Model](#multi-sig-governance-model) section above and
require a full signing ceremony.

### How WASM Upgrades Work

Upgrading a contract replaces the executable code identified by the contract
address. The contract must expose an `upgrade` function that calls
`env.deployer().update_current_contract_wasm(new_wasm_hash)`. The new WASM
must be uploaded to the ledger before the upgrade transaction is submitted.

A `SYSTEM` contract event is emitted automatically on upgrade with:

- `topics = ["executable_update", old_executable, new_executable]`
- `data = []`

Backend services that monitor contract events can use this to detect upgrades.

### Upgrade Procedure

1. **Open an upgrade issue** — Include the target contract(s), target commit
   SHA, reason for upgrade, and expected WASM hashes.
2. **Collect multi-sig approvals** — Follow the same approval process as
   initial deployment.
3. **Build and verify artifacts** from a clean checkout:

   ```sh
   git clone --branch <TAG> --depth 1 <REPO_URL>
   cd COMEBACKHERE-contracts/
   cargo build --target wasm32-unknown-unknown --release
   sha256sum target/wasm32-unknown-unknown/release/comebackhere_*.wasm
   ```

4. **Upload new WASM to the ledger** (does not affect the live contract):

   ```sh
   stellar contract upload \
     --source-account <ADMIN_KEY> \
     --wasm target/wasm32-unknown-unknown/release/<CONTRACT>.wasm \
     --network mainnet
   # Outputs: <NEW_WASM_HASH>
   ```

5. **Invoke the upgrade function** through the standard ceremony process:

   ```sh
   stellar contract invoke \
     --id <CONTRACT_ID> \
     --source-account <ADMIN_KEY> \
     --network mainnet \
     -- upgrade \
     --new_wasm_hash <NEW_WASM_HASH>
   ```

6. **Verify** the upgrade by querying contract state and running the
   post-ceremony smoke test.
7. **Record** the new WASM hash and transaction hash in the upgrade issue.

The contract address does not change. Update `INVOICE_CONTRACT_ID`,
`TREASURY_CONTRACT_ID`, or `COMPLIANCE_CONTRACT_ID` in backend secrets only
if a new contract was deployed rather than upgraded in-place.

### Upgrade Authorization

Each contract enforces admin authorization in its `upgrade` function:

```rust
pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
    let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
    admin.require_auth();
    env.deployer().update_current_contract_wasm(new_wasm_hash);
}
```

The `--source-account` used to invoke `upgrade` must match the contract's
stored admin address. The compliance contract admin key must be used for
compliance contract upgrades; the treasury admin key for treasury upgrades.

### Storage Migration

If an upgrade changes a stored data structure (adds, removes, or renames
fields), old ledger entries written by the previous version must be handled
explicitly. Reading an old entry with a new incompatible type causes the host
to trap with `Error(Object, UnexpectedSize)`.

#### Recommended pattern: versioned enum

Wrap each stored type in a versioned enum so old and new layouts can coexist:

```rust
#[contracttype]
pub struct DataV1 { a: i64, b: i64 }

#[contracttype]
pub struct DataV2 { a: i64, b: i64, c: Option<i64> }

#[contracttype]
pub enum Data {
    V1(DataV1),
    V2(DataV2),
}

impl Data {
    pub fn into_v2(self) -> DataV2 {
        match self {
            Data::V1(v1) => DataV2 { a: v1.a, b: v1.b, c: None },
            Data::V2(v2) => v2,
        }
    }
}
```

Reads call `into_v2()` to up-convert lazily; writes always store `Data::V2`.

#### Lazy vs eager migration

| Strategy | When to use | Risk |
| -------- | ----------- | ---- |
| **Lazy** (convert on read) | Default choice; large or unbounded datasets | None at upgrade time; old entries persist until accessed |
| **Eager** (batch rewrite via admin function) | Small, bounded datasets where old version branches must be retired | Hits instruction limits if record count is large; contract is in mixed-version state during the migration window |

Lazy migration is preferred for COMEBACKHERE contracts. Old entries are
up-converted the first time they are read after the upgrade and written back
in the new format. No explicit migration transaction is required.

If an eager migration is necessary (e.g., to retire old version branches),
scope it to a dedicated `migrate(ids: Vec<u32>)` admin function that processes
a bounded batch per transaction, and gate it behind the same admin
authorization as `upgrade`.

### Upgrade Abort Conditions

- WASM hash of the uploaded artifact does not match the upgrade issue
- Admin authorization check fails
- Post-upgrade smoke test fails or contract returns unexpected state
- Any signer mismatch during the ceremony

If the upgrade transaction has not been submitted, abort by closing the upgrade
issue without submitting. Once submitted, the upgrade cannot be rolled back
directly — follow the Emergency Rollback procedure above and schedule a
corrective upgrade through the full ceremony process.

### Upgrade Checklist

#### Pre-Upgrade (Lead Deployer, 24–48 hours before)

- [ ] Open a GitHub upgrade issue with target contract(s), commit SHA, and
      reason for upgrade
- [ ] Build WASM artifacts from a clean checkout and compute SHA-256 hashes
- [ ] Post hashes in the upgrade issue and tag required signers
- [ ] Identify any storage structure changes in the diff and document the
      migration strategy in the upgrade issue
- [ ] Confirm Soroban mainnet RPC health

#### Upgrade Execution (All signers, synchronous)

- [ ] Roll call — confirm identity of all signers
- [ ] Each signer independently verifies WASM hashes match the upgrade issue
- [ ] Upload new WASM with `stellar contract upload`; confirm the returned hash
- [ ] Invoke `upgrade` with the new WASM hash through the approved signer
- [ ] Wait for transaction confirmation; record transaction hash
- [ ] Run post-upgrade smoke test
- [ ] Record transaction hash in the upgrade issue

#### Post-Upgrade (Lead Deployer, within 24 hours)

- [ ] Update `abis/` with new contract metadata
- [ ] Open a PR to update ABI snapshots and any configuration references
- [ ] Notify the team that the upgrade is live
