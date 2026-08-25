import { Router, type Request, type Response } from "express"
import { Keypair, nativeToScVal } from "stellar-sdk"
import {
  buildSorobanClient,
  getNetworkPassphrase,
  simulateContractRead,
  submitContractCall,
  type SorobanClient,
} from "../lib/soroban.js"
import { validateBody } from "../middleware/validate.js"
import { thresholdSchema } from "../schemas/index.js"

const router = Router()

function requireEnv(res: Response): {
  rpcUrl: string
  treasuryContractId: string
  signerSecret: string
  networkPassphrase: string
} | null {
  const rpcUrl = process.env.SOROBAN_RPC_URL
  const treasuryContractId = process.env.TREASURY_CONTRACT_ID
  const signerSecret = process.env.SIGNER_SECRET_KEY
  const networkPassphrase = getNetworkPassphrase()

  if (!rpcUrl || !treasuryContractId || !signerSecret) {
    res.status(503).json({
      error: "Service misconfiguration: missing required environment variables",
    })
    return null
  }

  return { rpcUrl, treasuryContractId, signerSecret, networkPassphrase }
}

/**
 * GET /api/treasury/threshold
 * Returns the current approval threshold from the treasury contract.
 */
router.get("/threshold", async (_req: Request, res: Response) => {
  const env = requireEnv(res)
  if (!env) return

  try {
    const client = buildSorobanClient(env.rpcUrl)
    const sourceAccount = Keypair.fromSecret(env.signerSecret).publicKey()
    const retval = await simulateContractRead(
      client,
      env.treasuryContractId,
      "get_threshold",
      [],
      sourceAccount,
      env.networkPassphrase,
    )
    const threshold = Number(retval.u64()?.toString() ?? "0")
    res.json({ threshold })
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status ?? 500
    const message = err instanceof Error ? err.message : String(err)
    res.status(status).json({ error: message })
  }
})

/**
 * POST /api/treasury/threshold
 * Body: { threshold: number } — must be a positive integer
 * Updates the treasury approval threshold via update_threshold.
 */
export async function setThreshold(
  threshold: number,
  env: {
    rpcUrl: string
    treasuryContractId: string
    signerSecret: string
    networkPassphrase: string
  },
  clientOverride?: SorobanClient,
): Promise<{ threshold: number; tx_hash: string }> {
  const client = clientOverride ?? buildSorobanClient(env.rpcUrl)
  const keypair = Keypair.fromSecret(env.signerSecret)

  const txHash = await submitContractCall(
    client,
    env.treasuryContractId,
    "update_threshold",
    [
      nativeToScVal(keypair.publicKey(), { type: "address" }),
      nativeToScVal(threshold, { type: "u32" }),
    ],
    env.signerSecret,
    env.networkPassphrase,
  )

  return { threshold, tx_hash: txHash }
}

router.post("/threshold", validateBody(thresholdSchema), async (req: Request, res: Response) => {
  const env = requireEnv(res)
  if (!env) return

  const threshold = req.body.threshold

  try {
    const result = await setThreshold(threshold, env)
    res.json(result)
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status ?? 500
    const message = err instanceof Error ? err.message : String(err)
    res.status(status).json({ error: message })
  }
})

export default router
