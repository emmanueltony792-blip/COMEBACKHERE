import { Router, type Request, type Response } from "express"
import { Keypair, nativeToScVal } from "stellar-sdk"
import {
  buildSorobanClient,
  getNetworkPassphrase,
  submitContractCall,
  type SorobanClient,
} from "../lib/soroban.js"
import { validateBody, validateParams } from "../middleware/validate.js"
import { releaseEscrowIdParamSchema } from "../schemas/index.js"

const router = Router({ mergeParams: true })

function requireEnv(res: Response): {
  rpcUrl: string
  invoiceContractId: string
  signerSecret: string
  networkPassphrase: string
} | null {
  const rpcUrl = process.env.SOROBAN_RPC_URL
  const invoiceContractId = process.env.INVOICE_CONTRACT_ID
  const signerSecret = process.env.SIGNER_SECRET_KEY
  const networkPassphrase = getNetworkPassphrase()

  if (!rpcUrl || !invoiceContractId || !signerSecret) {
    res.status(503).json({
      error: "Service misconfiguration: missing required environment variables",
    })
    return null
  }

  return { rpcUrl, invoiceContractId, signerSecret, networkPassphrase }
}

export interface ReleaseEscrowResult {
  invoice_id: number
  status: "Released"
  tx_hash: string
}

/**
 * Core logic — exported so it can be tested with an injected client.
 *
 * Calls `release_escrow(invoice_id, caller)` on the invoice contract.
 * The signer keypair (SIGNER_SECRET_KEY) acts as the caller / admin.
 *
 * Contract error codes that surface as HTTP 403:
 *   Unauthorized = 1  — caught as a generic unauthorised signal
 */
export async function releaseEscrow(
  invoiceId: number,
  env: {
    rpcUrl: string
    invoiceContractId: string
    signerSecret: string
    networkPassphrase: string
  },
  clientOverride?: SorobanClient,
): Promise<ReleaseEscrowResult> {
  const client = clientOverride ?? buildSorobanClient(env.rpcUrl)
  const keypair = Keypair.fromSecret(env.signerSecret)

  const txHash = await submitContractCall(
    client,
    env.invoiceContractId,
    "release_escrow",
    [
      nativeToScVal(BigInt(invoiceId), { type: "u64" }),
      nativeToScVal(keypair.publicKey(), { type: "address" }),
    ],
    env.signerSecret,
    env.networkPassphrase,
  )

  return { invoice_id: invoiceId, status: "Released", tx_hash: txHash }
}

/**
 * POST /invoices/:id/release-escrow
 *
 * Admin-only endpoint that triggers `release_escrow` on the invoice contract,
 * transitioning a paid invoice to the Released state.
 *
 * Authorization: requires the `x-admin-key` header to match ADMIN_KEY env var.
 *
 * Responses:
 *   200 { invoice_id, status: "Released", tx_hash }
 *   400  id is not a positive integer
 *   401  missing or invalid x-admin-key header
 *   403  contract returned Unauthorized (error code 1)
 *   503  required environment variables missing
 *   5xx  unexpected Soroban / network error
 */
router.post("/:id/release-escrow", validateParams(releaseEscrowIdParamSchema), async (req: Request, res: Response) => {
  // Admin-only authorization
  const adminKey = req.headers["x-admin-key"]
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    res.status(401).json({ error: "Unauthorized" })
    return
  }

  const { id } = req.params

  const invoiceId = parseInt(id, 10)
  const env = requireEnv(res)
  if (!env) return

  try {
    const result = await releaseEscrow(invoiceId, env)
    res.status(200).json(result)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)

    // Contract error Unauthorized = 1 → 403
    if (message.includes("Error(Contract, #1)") || message.toUpperCase().includes("UNAUTHORIZED")) {
      res.status(403).json({ error: "Forbidden: caller is not authorised to release this escrow", code: 1 })
      return
    }

    const status = (err as { status?: number })?.status ?? 500
    res.status(status).json({ error: message })
  }
})

export default router
