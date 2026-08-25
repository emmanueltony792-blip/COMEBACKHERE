# Development Environment Troubleshooting

This guide covers the most common problems developers encounter during local setup and how to resolve them.

## Soroban RPC Connection Errors

### "Soroban RPC not reachable" or connection refused on port 8000

The local Soroban sandbox is not running or has not finished starting.

**Check the container status:**

```sh
docker compose ps
```

If the `soroban` service is not listed or shows `Restarting`, inspect its logs:

```sh
docker compose logs soroban
```

**Common causes and fixes:**

| Symptom | Cause | Fix |
| --- | --- | --- |
| `connection refused` on `localhost:8000` | Container not started | Run `docker compose up -d` or `make dev` |
| Container starts then immediately exits | Corrupted volume data | `docker compose down -v && docker compose up -d` |
| `health: starting` stays for more than 60 seconds | Slow initial ledger catch-up | Wait up to 90 seconds; the healthcheck has a 30-second `start_period` and retries every 5 seconds |
| `ECONNREFUSED` from the backend but `curl localhost:8000` works | Backend is using the Docker network hostname (`soroban`) but running outside Docker | Set `SOROBAN_RPC_URL=http://localhost:8000` in the backend `.env` when running natively |

### "Transaction simulation failed" or "contract not found"

The contract IDs saved in your `.env` do not match what was deployed to the local sandbox.

```sh
# Redeploy contracts and capture fresh IDs
cd COMEBACKHERE && ./scripts/deploy_testnet.sh

# Update .env files with the new contract IDs printed by the script
```

If you previously ran `docker compose down -v`, all ledger state (including deployed contracts) was wiped. You must redeploy after every volume reset.

### Wrong network passphrase

When using the standalone sandbox the passphrase must be:

```
Standalone Network ; February 2025
```

Ensure both `VITE_NETWORK_PASSPHRASE` (frontend) and `NETWORK_PASSPHRASE` (Soroban CLI config) use this exact string. A mismatched passphrase causes silent transaction failures.

## USDC Test-Asset Funding Failures

### "USDC balance insufficient" during payment testing

The local standalone sandbox does not come with pre-minted USDC. You need to either:

1. **Use the Stellar Laboratory** to fund your testnet account (when using public testnet):

   ```
   https://laboratory.stellar.org/#create-account
   ```

2. **Mint test USDC locally** using the deploy script, which sets up a test USDC token contract with the address `CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4`.

### Friendbot failures on testnet

If Stellar Friendbot is down or rate-limiting your requests:

```sh
# Check if friendbot is responsive
curl https://friendbot.stellar.org?addr=YOUR_PUBLIC_KEY
```

**Workarounds:**

- Wait 60 seconds and retry; Friendbot rate-limits to roughly one request per account per minute.
- Use a different testnet keypair: `soroban config identity generate dev2`
- Switch to the local standalone sandbox instead of testnet, which does not require Friendbot.

### "Token contract not found" when paying invoices

The USDC contract ID in your `.env` must match the actual deployed test token. On the local sandbox, the deploy script outputs this ID. If you changed sandboxes or reset volumes, redeploy:

```sh
./scripts/deploy_testnet.sh
# Copy the printed USDC_CONTRACT_ID into your .env files
```

## Docker Port Conflicts

### "Bind for 0.0.0.0:8000: address already in use"

Another process is already listening on port 8000 (or 11625, 11626, 6379, 3000, 5173).

**Find what is using the port:**

```sh
# Linux
sudo lsof -i :8000

# macOS
lsof -i :8000
```

**Fixes:**

1. **Stop the conflicting process** if it is a leftover container or old dev server:

   ```sh
   docker compose down
   # or kill the specific process
   kill <PID>
   ```

2. **Remap ports** by creating or editing `docker-compose.override.yml` (this file is gitignored):

   ```yaml
   version: '3.8'
   services:
     soroban:
       ports:
         - "9000:8000"      # Soroban RPC on 9000 instead of 8000
         - "11627:11626"
         - "11628:11625"
     redis:
       ports:
         - "6380:6379"      # Redis on 6380 instead of 6379
   ```

   Then update your `.env` files to use the new ports:

   ```sh
   SOROBAN_RPC_URL=http://localhost:9000
   ```

### Port conflicts between native and Docker services

Running both `cargo run` (native backend) and the Docker `backend` service will conflict on port 3000. Pick one approach:

- **Docker-only**: use `docker compose -f docker-compose.yml -f docker-compose.override.yml up`
- **Native backend**: stop the Docker backend service: `docker compose stop backend`, then run `cargo run` directly.

### Redis port conflict (6379)

If you have a system Redis running:

```sh
# Check if system Redis is active
systemctl status redis 2>/dev/null || brew services list 2>/dev/null | grep redis

# Stop system Redis
sudo systemctl stop redis   # Linux
brew services stop redis     # macOS
```

Or remap the Docker Redis port as shown above.

## General Tips

- **Reset everything**: `docker compose down -v && docker compose up -d && ./scripts/deploy_testnet.sh`
- **View all logs**: `docker compose logs -f`
- **Check service health**: `docker compose ps` shows healthcheck status for each service
- **Verify RPC is responding**: `curl http://localhost:8000/health`
- **Verify Redis is responding**: `docker compose exec redis redis-cli ping` (should return `PONG`)

## Request Tracing with Correlation IDs

Every request handled by `comebackhere-backend` carries a unique `X-Request-Id`
header that is echoed back on the response. This ID is the primary key for
tracing a single request across backend logs, the treasury indexer, and webhook
delivery.

### How it works

- If your client already sets an `X-Request-Id` header the backend preserves
  that value unchanged.
- Otherwise the backend generates a new UUID v4 and attaches it to both the
  request context (`res.locals.requestId`) and the response header.

### Filtering logs by correlation ID

Capture the ID from a response and grep backend logs:

```sh
# Store the ID from a curl call
REQUEST_ID=$(curl -si http://localhost:3000/invoices/1 | grep -i x-request-id | awk '{print $2}' | tr -d '\r')
echo "Tracing request: $REQUEST_ID"

# Filter Docker logs
docker compose logs backend 2>&1 | grep "$REQUEST_ID"
```

### Supplying your own trace ID

Pass an existing trace ID from your client or a distributed tracing system:

```sh
curl -H "X-Request-Id: my-trace-id-abc123" http://localhost:3000/invoices/1
```

The response will echo the same `X-Request-Id: my-trace-id-abc123` header,
confirming the backend used your ID throughout the request lifecycle.
