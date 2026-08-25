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
import { graceWindowSchema } from "../schemas/index.js"

const router = Router()

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

/**
 * @openapi
 * /api/invoice/grace-window:
 *   get:
 *     tags: [Invoice Settings]
 *     summary: Get current invoice grace window
 *     responses:
 *       200:
 *         description: Current grace window in seconds
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 grace_window_seconds:
 *                   type: integer
 *                   example: 86400
 *       503:
 *         description: Service misconfiguration
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/grace-window", async (_req: Request, res: Response) => {
  const env = requireEnv(res)
  if (!env) return

  try {
    const client = buildSorobanClient(env.rpcUrl)
    const sourceAccount = Keypair.fromSecret(env.signerSecret).publicKey()
    const retval = await simulateContractRead(
      client,
      env.invoiceContractId,
      "get_grace_window",
      [],
      sourceAccount,
      env.networkPassphrase,
    )
    const seconds = Number(retval.u64()?.toString() ?? "86400")
    res.json({ grace_window_seconds: seconds })
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status ?? 500
    const message = err instanceof Error ? err.message : String(err)
    res.status(status).json({ error: message })
  }
})

/**
 * POST /api/invoice/grace-window
 * Body: { grace_window_seconds: number }
 */
export async function setGraceWindow(
  graceWindowSeconds: number,
  env: {
    rpcUrl: string
    invoiceContractId: string
    signerSecret: string
    networkPassphrase: string
  },
  clientOverride?: SorobanClient,
): Promise<{ grace_window_seconds: number; tx_hash: string }> {
  const client = clientOverride ?? buildSorobanClient(env.rpcUrl)
  const keypair = Keypair.fromSecret(env.signerSecret)

  const txHash = await submitContractCall(
    client,
    env.invoiceContractId,
    "set_grace_window",
    [
      nativeToScVal(keypair.publicKey(), { type: "address" }),
      nativeToScVal(BigInt(graceWindowSeconds), { type: "u64" }),
    ],
    env.signerSecret,
    env.networkPassphrase,
  )

  return { grace_window_seconds: graceWindowSeconds, tx_hash: txHash }
}

/**
 * @openapi
 * /api/invoice/grace-window:
 *   post:
 *     tags: [Invoice Settings]
 *     summary: Update invoice grace window
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [grace_window_seconds]
 *             properties:
 *               grace_window_seconds:
 *                 type: integer
 *                 description: Positive integer (1–2592000 seconds / 30 days)
 *                 example: 172800
 *                 minimum: 1
 *                 maximum: 2592000
 *     responses:
 *       200:
 *         description: Grace window updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 grace_window_seconds:
 *                   type: integer
 *                   example: 172800
 *                 tx_hash:
 *                   type: string
 *                   example: "abc123..."
 *       400:
 *         description: Validation error — grace_window_seconds out of range or wrong type
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       503:
 *         description: Service misconfiguration
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post("/grace-window", validateBody(graceWindowSchema), async (req: Request, res: Response) => {
  const env = requireEnv(res)
  if (!env) return

  const graceWindowSeconds = req.body.grace_window_seconds

  try {
    const result = await setGraceWindow(graceWindowSeconds, env)
    res.json(result)
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status ?? 500
    const message = err instanceof Error ? err.message : String(err)
    res.status(status).json({ error: message })
  }
})

export default router
