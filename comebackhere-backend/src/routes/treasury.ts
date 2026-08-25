import { Router, type Request, type Response } from "express"
import { Keypair, nativeToScVal, Address } from "stellar-sdk"
import {
  buildSorobanClient,
  getNetworkPassphrase,
  getOnChainSettlement,
  getTokenBalance,
  submitContractCall,
  type SorobanClient,
} from "../lib/soroban.js"
import { connectMongo, getSettlementsCollection } from "../db/mongo.js"
import { validateBody } from "../middleware/validate.js"
import {
  settlementIdSchema,
  executeSettlementSchema,
  escalateHoldSchema,
} from "../schemas/index.js"

const router = Router()

function requireEnv(res: Response): {
  rpcUrl: string
  treasuryContractId: string
  usdcContractId: string
  signerSecret: string
  networkPassphrase: string
} | null {
  const rpcUrl = process.env.SOROBAN_RPC_URL
  const treasuryContractId = process.env.TREASURY_CONTRACT_ID
  const usdcContractId = process.env.USDC_CONTRACT_ID
  const signerSecret = process.env.SIGNER_SECRET_KEY
  const networkPassphrase = getNetworkPassphrase()

  if (!rpcUrl || !treasuryContractId || !usdcContractId || !signerSecret) {
    res.status(503).json({
      error: "Service misconfiguration: missing required environment variables",
    })
    return null
  }

  return { rpcUrl, treasuryContractId, usdcContractId, signerSecret, networkPassphrase }
}

/**
 * @openapi
 * /api/treasury/pending-settlements:
 *   get:
 *     tags: [Treasury]
 *     summary: Get all pending settlements
 *     responses:
 *       200:
 *         description: List of pending settlements
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/SettlementRecord'
 *       500:
 *         description: Database error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/pending-settlements", async (_req: Request, res: Response) => {
  try {
    const database = await connectMongo()
    const settlements = getSettlementsCollection(database)
    const records = await settlements
      .find({ status: "Pending" })
      .sort({ id: 1 })
      .toArray()

    res.json(
      records.map((s) => ({
        id: s.id,
        merchant_address: s.merchant_address,
        amount: s.amount,
        approvals: s.approvals,
        approval_weight: s.approval_weight,
        status: s.status,
        hold_reason: s.hold_reason,
      })),
    )
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

/**
 * @openapi
 * /api/treasury/approve-settlement:
 *   post:
 *     tags: [Treasury]
 *     summary: Approve a pending settlement
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [settlement_id]
 *             properties:
 *               settlement_id:
 *                 type: integer
 *                 description: Positive integer settlement ID
 *                 example: 1
 *     responses:
 *       200:
 *         description: Settlement approved
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SettlementRecord'
 *       400:
 *         description: settlement_id is not a positive integer
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
router.post("/approve-settlement", validateBody(settlementIdSchema), async (req: Request, res: Response) => {
  const env = requireEnv(res)
  if (!env) return

  const settlementId = req.body.settlement_id

  try {
    const client = buildSorobanClient(env.rpcUrl)
    const keypair = Keypair.fromSecret(env.signerSecret)

    const txHash = await submitContractCall(
      client,
      env.treasuryContractId,
      "approve_settlement",
      [
        nativeToScVal(keypair.publicKey(), { type: "address" }),
        nativeToScVal(BigInt(settlementId), { type: "u64" }),
      ],
      env.signerSecret,
      env.networkPassphrase,
    )

    const database = await connectMongo()
    const settlements = getSettlementsCollection(database)
    const record = await settlements.findOne({ id: settlementId })

    res.json(
      record ?? {
        id: settlementId,
        merchant_address: "",
        amount: "0",
        approvals: [keypair.publicKey()],
        approval_weight: 1,
        status: "Pending",
        hold_reason: null,
        tx_hash: txHash,
      },
    )
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status ?? 500
    const message = err instanceof Error ? err.message : String(err)
    res.status(status).json({ error: message })
  }
})

export interface ExecuteSettlementBody {
  settlement_id: number
  token_contract?: string
}

export interface SettlementExecutionDeps {
  getOnChainSettlement: typeof getOnChainSettlement
  getTokenBalance: typeof getTokenBalance
  submitContractCall: typeof submitContractCall
}

const defaultSettlementDeps: SettlementExecutionDeps = {
  getOnChainSettlement,
  getTokenBalance,
  submitContractCall,
}

/**
 * POST /api/treasury/execute-settlement
 * Validates treasury USDC balance before submitting execute_settlement.
 * Body: { settlement_id: number, token_contract?: string }
 */
export async function executeSettlementWithBalanceCheck(
  body: ExecuteSettlementBody,
  env: {
    rpcUrl: string
    treasuryContractId: string
    usdcContractId: string
    signerSecret: string
    networkPassphrase: string
  },
  clientOverride?: SorobanClient,
  deps: SettlementExecutionDeps = defaultSettlementDeps,
): Promise<{ tx_hash: string; settlement_id: number; balance_checked: string; amount_required: string }> {
  const client = clientOverride ?? buildSorobanClient(env.rpcUrl)
  const keypair = Keypair.fromSecret(env.signerSecret)
  const sourceAccount = keypair.publicKey()
  const tokenContract = body.token_contract ?? env.usdcContractId

  const settlement = await deps.getOnChainSettlement(
    client,
    env.treasuryContractId,
    BigInt(body.settlement_id),
    sourceAccount,
    env.networkPassphrase,
  )

  if (settlement.status !== "Pending") {
    throw Object.assign(
      new Error(`Settlement #${body.settlement_id} is not pending (status: ${settlement.status})`),
      { status: 409 },
    )
  }

  const balance = await deps.getTokenBalance(
    client,
    tokenContract,
    env.treasuryContractId,
    sourceAccount,
    env.networkPassphrase,
  )

  console.log(
    `[execute-settlement] settlement_id=${body.settlement_id} ` +
      `required=${settlement.amount.toString()} available=${balance.toString()} ` +
      `token=${tokenContract}`,
  )

  if (balance < settlement.amount) {
    throw Object.assign(
      new Error(
        `Insufficient treasury USDC balance: available ${balance.toString()} stroops, ` +
          `required ${settlement.amount.toString()} stroops for settlement #${body.settlement_id}`,
      ),
      { status: 422 },
    )
  }

  const txHash = await deps.submitContractCall(
    client,
    env.treasuryContractId,
    "execute_settlement",
    [
      nativeToScVal(sourceAccount, { type: "address" }),
      nativeToScVal(BigInt(body.settlement_id), { type: "u64" }),
      nativeToScVal(Address.fromString(tokenContract), { type: "address" }),
    ],
    env.signerSecret,
    env.networkPassphrase,
  )

  return {
    tx_hash: txHash,
    settlement_id: body.settlement_id,
    balance_checked: balance.toString(),
    amount_required: settlement.amount.toString(),
  }
}

/**
 * @openapi
 * /api/treasury/execute-settlement:
 *   post:
 *     tags: [Treasury]
 *     summary: Execute a fully-approved settlement
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [settlement_id]
 *             properties:
 *               settlement_id:
 *                 type: integer
 *                 description: Positive integer settlement ID
 *                 example: 1
 *               token_contract:
 *                 type: string
 *                 description: Token contract address (defaults to USDC_CONTRACT_ID env var)
 *     responses:
 *       200:
 *         description: Settlement executed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tx_hash:
 *                   type: string
 *                   example: "abc123..."
 *                 settlement_id:
 *                   type: integer
 *                   example: 1
 *                 balance_checked:
 *                   type: string
 *                   example: "10000000"
 *                 amount_required:
 *                   type: string
 *                   example: "5000000"
 *       400:
 *         description: settlement_id is not a positive integer
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Settlement is not in Pending status
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       422:
 *         description: Insufficient balance or simulation failure
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
router.post("/execute-settlement", validateBody(executeSettlementSchema), async (req: Request, res: Response) => {
  const env = requireEnv(res)
  if (!env) return

  const { settlement_id: settlementId, token_contract } = req.body as { settlement_id: number; token_contract?: string }

  try {
    const result = await executeSettlementWithBalanceCheck(
      { settlement_id: settlementId, token_contract },
      env,
    )
    res.json(result)
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status ?? 500
    const message = err instanceof Error ? err.message : String(err)
    res.status(status).json({ error: message })
  }
})

/**
 * @openapi
 * /api/treasury/on-hold-settlements:
 *   get:
 *     tags: [Treasury]
 *     summary: Get all on-hold settlements
 *     responses:
 *       200:
 *         description: List of on-hold settlements
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 settlements:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SettlementRecord'
 *       500:
 *         description: Database error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/on-hold-settlements", async (_req: Request, res: Response) => {
  try {
    const database = await connectMongo()
    const settlements = getSettlementsCollection(database)
    const records = await settlements
      .find({ status: "OnHold" })
      .sort({ id: 1 })
      .toArray()

    res.json(
      records.map((s) => ({
        id: s.id,
        merchant_address: s.merchant_address,
        amount: s.amount,
        approvals: s.approvals,
        approval_weight: s.approval_weight,
        status: s.status,
        hold_reason: s.hold_reason,
      })),
    )
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

/**
 * @openapi
 * /api/treasury/release-hold:
 *   post:
 *     tags: [Treasury]
 *     summary: Release a held settlement back to Pending
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [settlement_id]
 *             properties:
 *               settlement_id:
 *                 type: integer
 *                 description: Positive integer settlement ID
 *                 example: 7
 *     responses:
 *       200:
 *         description: Settlement released to Pending
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SettlementRecord'
 *       400:
 *         description: settlement_id is not a positive integer
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Settlement is not currently on hold
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post("/release-hold", validateBody(settlementIdSchema), async (req: Request, res: Response) => {
  const settlementId = req.body.settlement_id

  try {
    const database = await connectMongo()
    const settlements = getSettlementsCollection(database)
    const record = await settlements.findOneAndUpdate(
      { id: settlementId, status: "OnHold" },
      { $set: { status: "Pending", hold_reason: null, updated_at: new Date() } },
      { returnDocument: "after" },
    )

    if (!record) {
      res.status(404).json({ error: `Settlement #${settlementId} not found or not on hold` })
      return
    }

    res.json({
      id: record.id,
      merchant_address: record.merchant_address,
      amount: record.amount,
      approvals: record.approvals,
      approval_weight: record.approval_weight,
      status: record.status,
      hold_reason: record.hold_reason,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

/**
 * @openapi
 * /api/treasury/escalate-hold:
 *   post:
 *     tags: [Treasury]
 *     summary: Escalate a held settlement to governance dispute
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [settlement_id]
 *             properties:
 *               settlement_id:
 *                 type: integer
 *                 description: Positive integer settlement ID
 *                 example: 7
 *               reason:
 *                 type: string
 *                 description: Human-readable reason (max 512 chars)
 *     responses:
 *       200:
 *         description: Settlement escalated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 dispute_id:
 *                   type: string
 *                   example: "7-1720000001000"
 *                 settlement_id:
 *                   type: string
 *                   example: "7"
 *                 status:
 *                   type: string
 *                   example: "Raised"
 *                 settlement_status:
 *                   type: string
 *                   example: "OnHold"
 *                 tx_hash:
 *                   type: string
 *                   example: "abc123..."
 *       400:
 *         description: settlement_id is not a positive integer
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       422:
 *         description: Soroban simulation or transaction failure
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
router.post("/escalate-hold", validateBody(escalateHoldSchema), async (req: Request, res: Response) => {
  const settlementId = req.body.settlement_id

  try {
    const database = await connectMongo()
    const settlements = getSettlementsCollection(database)
    const record = await settlements.findOneAndUpdate(
      { id: settlementId, status: "OnHold" },
      { $set: { hold_reason: "AdminHold", updated_at: new Date() } },
      { returnDocument: "after" },
    )

    if (!record) {
      res.status(404).json({ error: `Settlement #${settlementId} not found or not on hold` })
      return
    }

    res.json({
      id: record.id,
      merchant_address: record.merchant_address,
      amount: record.amount,
      approvals: record.approvals,
      approval_weight: record.approval_weight,
      status: record.status,
      hold_reason: record.hold_reason,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

/**
 * GET /api/treasury/balances
 * Returns token balances held by the treasury contract.
 */
router.get("/balances", async (_req: Request, res: Response) => {
  const env = requireEnv(res)
  if (!env) return

  try {
    const client = buildSorobanClient(env.rpcUrl)
    const keypair = Keypair.fromSecret(env.signerSecret)
    const sourceAccount = keypair.publicKey()

    const balance = await getTokenBalance(
      client,
      env.usdcContractId,
      env.treasuryContractId,
      sourceAccount,
      env.networkPassphrase,
    )

    res.json([{ token: env.usdcContractId, balance: balance.toString() }])
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status ?? 500
    const message = err instanceof Error ? err.message : String(err)
    res.status(status).json({ error: message })
  }
})

export default router
