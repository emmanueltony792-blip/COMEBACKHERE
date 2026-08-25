import { Router, type Request, type Response } from "express"
import {
  Keypair,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  Contract,
  nativeToScVal,
  SorobanRpc,
} from "stellar-sdk"
import { validateBody } from "../middleware/validate.js"
import { allowBodySchema, blockBodySchema } from "../schemas/index.js"

const router = Router()

// ---------------------------------------------------------------------------
// Shared Soroban client type — mirrors invoices.ts convention
// ---------------------------------------------------------------------------

export type SorobanClient = {
  getAccount: (publicKey: string) => Promise<Parameters<TransactionBuilder["constructor"]>[0]>
  simulateTransaction: (tx: Parameters<SorobanRpc.Server["simulateTransaction"]>[0]) => ReturnType<SorobanRpc.Server["simulateTransaction"]>
  sendTransaction: (tx: Parameters<SorobanRpc.Server["sendTransaction"]>[0]) => ReturnType<SorobanRpc.Server["sendTransaction"]>
  getTransaction: (hash: string) => ReturnType<SorobanRpc.Server["getTransaction"]>
}

function buildSorobanClient(rpcUrl: string): SorobanClient {
  const server = new SorobanRpc.Server(rpcUrl)
  return {
    getAccount: (pk) => server.getAccount(pk),
    simulateTransaction: (tx) => server.simulateTransaction(tx),
    sendTransaction: (tx) => server.sendTransaction(tx),
    getTransaction: (hash) => server.getTransaction(hash),
  }
}

function envOrError(): { rpcUrl: string; contractId: string; signerSecret: string; networkPassphrase: string } | null {
  const rpcUrl = process.env.SOROBAN_RPC_URL
  const contractId = process.env.COMPLIANCE_CONTRACT_ID
  const signerSecret = process.env.SIGNER_SECRET_KEY
  const networkPassphrase = process.env.NETWORK_PASSPHRASE ?? Networks.STANDALONE
  if (!rpcUrl || !contractId || !signerSecret) return null
  return { rpcUrl, contractId, signerSecret, networkPassphrase }
}

// ---------------------------------------------------------------------------
// Core call — submit a compliance operation and return updated status
// ---------------------------------------------------------------------------

export async function callComplianceOp(
  operation: "allow_address" | "block_address" | "allow_address_until",
  args: ReturnType<typeof nativeToScVal>[],
  client: SorobanClient,
  contractId: string,
  signerSecret: string,
  networkPassphrase: string
): Promise<{ address: string; status: string; hash: string }> {
  const keypair = Keypair.fromSecret(signerSecret)
  const contract = new Contract(contractId)

  const account = await client.getAccount(keypair.publicKey())
  const tx = new TransactionBuilder(account as any, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(operation, ...args))
    .setTimeout(30)
    .build()

  const simulated = await client.simulateTransaction(tx)
  if (SorobanRpc.Api.isSimulationError(simulated)) {
    throw Object.assign(
      new Error(`Soroban simulation failed: ${(simulated as any).error}`),
      { status: 422 }
    )
  }

  const prepared = SorobanRpc.assembleTransaction(tx, simulated as any).build()
  prepared.sign(keypair)

  const sendResult = await client.sendTransaction(prepared)
  if (sendResult.status === "ERROR") {
    throw Object.assign(
      new Error(`Soroban submission failed: ${(sendResult as any).errorResult?.toXDR("base64")}`),
      { status: 422 }
    )
  }

  const hash = sendResult.hash
  let getResult: SorobanRpc.Api.GetTransactionResponse | null = null
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    getResult = await client.getTransaction(hash)
    if (getResult.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) break
  }

  if (!getResult || getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
    throw Object.assign(new Error("Transaction confirmation timeout"), { status: 504 })
  }
  if (getResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    throw Object.assign(new Error("Soroban transaction failed"), { status: 422 })
  }

  const statusMap: Record<string, string> = {
    allow_address: "Allowed",
    block_address: "Blocked",
    allow_address_until: "AllowedUntil",
  }

  return {
    address: (args[0] as any).address?.toString() ?? "",
    status: statusMap[operation],
    hash,
  }
}

// ---------------------------------------------------------------------------
// POST /compliance/allow  (#66)
// Admin-only — calls allow_address (or allow_address_until if until provided)
// ---------------------------------------------------------------------------

export interface AllowBody {
  address: string
  until?: number // optional Unix timestamp for time-bounded allowance
}

/**
 * POST /compliance/allow
 * Body: { address: string, until?: number }
 * Returns: { address, status, hash }
 */
router.post("/allow", validateBody(allowBodySchema), async (req: Request, res: Response) => {
  const adminKey = req.headers["x-admin-key"]
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    res.status(401).json({ error: "Unauthorized" })
    return
  }

  const { address, until } = req.body as { address: string; until?: number }

  const env = envOrError()
  if (!env) {
    res.status(503).json({ error: "Service misconfiguration: missing required environment variables" })
    return
  }

  try {
    const client = buildSorobanClient(env.rpcUrl)
    const operation = until ? "allow_address_until" : "allow_address"
    const args = until
      ? [nativeToScVal(address, { type: "address" }), nativeToScVal(until, { type: "u64" })]
      : [nativeToScVal(address, { type: "address" })]

    const result = await callComplianceOp(
      operation as "allow_address" | "allow_address_until",
      args,
      client,
      env.contractId,
      env.signerSecret,
      env.networkPassphrase
    )
    res.status(200).json(result)
  } catch (err: unknown) {
    const status = (err as any)?.status ?? 500
    const message = err instanceof Error ? err.message : String(err)
    res.status(status).json({ error: message })
  }
})

// ---------------------------------------------------------------------------
// POST /compliance/block  (#68)
// Admin-only — calls block_address; logs admin identity and timestamp
// ---------------------------------------------------------------------------

export interface BlockBody {
  address: string
}

/**
 * POST /compliance/block
 * Body: { address: string }
 * Returns: { address, status, hash }
 */
router.post("/block", validateBody(blockBodySchema), async (req: Request, res: Response) => {
  const adminKey = req.headers["x-admin-key"]
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    res.status(401).json({ error: "Unauthorized" })
    return
  }

  const { address } = req.body as { address: string }

  const env = envOrError()
  if (!env) {
    res.status(503).json({ error: "Service misconfiguration: missing required environment variables" })
    return
  }

  // Audit log — admin identity + timestamp
  console.log(`[compliance] block_address admin="${adminKey}" address="${address}" ts="${new Date().toISOString()}"`)

  try {
    const client = buildSorobanClient(env.rpcUrl)
    const result = await callComplianceOp(
      "block_address",
      [nativeToScVal(address, { type: "address" })],
      client,
      env.contractId,
      env.signerSecret,
      env.networkPassphrase
    )
    res.status(200).json(result)
  } catch (err: unknown) {
    const status = (err as any)?.status ?? 500
    const message = err instanceof Error ? err.message : String(err)
    res.status(status).json({ error: message })
  }
})

export default router
