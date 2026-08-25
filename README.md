# COMEBACKHERE Protocol

> **The Stripe for Stellar**
> Secure, scalable, and developer-friendly payment infrastructure built on the Stellar network.

This repository contains the tooling, deployment scripts, contract ABIs, documentation, and integration resources required to develop, deploy, and maintain the **COMEBACKHERE Protocol**.

---

## Overview

COMEBACKHERE provides the infrastructure needed to build seamless payment experiences on Stellar. This repository serves as the central workspace for:

* Smart contract deployment
* ABI generation and management
* Developer documentation
* Local development tooling
* Integration and deployment scripts
* Workspace-level testing

---

## Architecture

The diagram below illustrates the primary payment flow through the COMEBACKHERE Protocol.

> *(Insert architecture or sequence diagram here.)*

---

## Repository Structure

```text
.
├── abis/          # Contract ABI files consumed by the backend
├── docs/          # Developer guides and deployment documentation
├── scripts/       # Deployment, verification, and utility scripts
└── tests/         # Workspace-level integration tests
```

| Directory  | Description                                            |
| ---------- | ------------------------------------------------------ |
| `abis/`    | Generated contract ABIs used by `comebackhere-backend` |
| `scripts/` | Deployment, verification, and ABI generation scripts   |
| `docs/`    | Technical documentation and deployment guides          |
| `tests/`   | Integration and workspace-level test suites            |

---

# Local Development

## Prerequisites

Before getting started, ensure you have:

* Docker
* Docker Compose

---

## Start the Development Environment

Launch all required services:

```bash
docker-compose up -d
```

This starts the following services:

| Service      | Description                                           | Default Port |
| ------------ | ----------------------------------------------------- | ------------ |
| Soroban Node | Stellar Quickstart environment (includes Horizon API) | `8000`       |
| Redis        | Event consumer backing service                        | `6379`       |

---

## Verify the Services

Check that the containers are running:

```bash
docker-compose ps
```

Verify the Soroban node is healthy:

```bash
curl http://localhost:8000/health
```

---

## Using `docker-compose.override.yml`

This repository includes a `docker-compose.override.yml` file.

Docker Compose automatically merges this file with `docker-compose.yml` whenever you run:

```bash
docker-compose up
```

The override configuration adds the following development services:

* Backend
* Frontend

This allows you to run the complete application stack locally without modifying the base compose configuration.

### Common Customizations

Developers often update the override file to:

* Change `VITE_API_URL`
* Change `VITE_SOROBAN_RPC`
* Modify port mappings
* Mount local source directories for hot reloading
* Customize environment-specific settings

To view the final merged configuration:

```bash
docker-compose config
```

---

# ABI Snapshot Verification

Before committing changes, ensure the generated ABI snapshots are up to date.

Using Make:

```bash
make check-abi-snapshots
```

Or with Just:

```bash
just check-snapshot
```

Finally, verify there are no uncommitted ABI changes:

```bash
git diff --exit-code abis/
```

---

# Deployment

## Testnet Deployment

Copy the example environment file:

```bash
cp .env.testnet.example .env.testnet
```

Deploy the contracts:

```bash
scripts/deploy_testnet.sh
```

After deployment, contract addresses are exported to:

```text
artifacts/addresses.json
```

This file is intentionally ignored by Git because it contains environment-specific deployment data.

For the expected structure, refer to:

```text
artifacts/addresses.json.example
```

---

## Mainnet Deployment

Mainnet deployments are intentionally **manual** and require approval through the project's multisignature governance process.

Before deploying to production, follow the complete deployment checklist and signing ceremony documented in:

```text
docs/MAINNET_DEPLOYMENT.md
```

---

# Contributing

Before opening a pull request:

* Keep ABI snapshots up to date.
* Verify all tests pass.
* Review deployment documentation if modifying contracts or deployment scripts.
* Ensure your branch is clean and free of unintended changes.

---

# License

This project is licensed under the **MIT License**.
