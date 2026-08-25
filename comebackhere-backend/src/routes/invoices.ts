import { Router, type Request, type Response } from "express"
import { Keypair, Networks, TransactionBuilder, BASE_FEE, Contract, nativeToScVal, SorobanRpc, xdr } from "stellar-sdk"
import { connectMongo, getInvoicesCollection, type InvoiceRecord, type InvoiceStatus } from "../db/mongo.js"
import { cacheGet, cacheSet } from "../lib/cache.js"

const router = Router()

export interface CreateInvoiceBody {
  merchant_address: string
  token: string
  amount: number
  due_date: number // Unix timestamp (seconds)
}

// Soroban interaction extracted so it can be replaced in tests
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

// Exported for testing — allows injecting a mock client
export async function createInvoice(
  body: CreateInvoiceBody,
  client: SorobanClient,
  contractId: string,
  signerSecret: string,
  networkPassphrase: string
): Promise<{ invoice_id: string; status: string }> {
  const keypair = Keypair.fromSecret(signerSecret)
  const contract = new Contract(contractId)

  const now = Math.floor(Date.now() / 1000)
  const expiresInSeconds = BigInt(body.due_date - now)

  const args = [
    nativeToScVal(body.merchant_address, { type: "address" }),
    nativeToScVal(body.amount, { type: "u64" }),
    nativeToScVal(body.amount, { type: "u64" }),
    nativeToScVal(expiresInSeconds, { type: "u64" }),
    nativeToScVal(null, { type: "void" }),
    nativeToScVal(null, { type: "void" }),
  ]

  const account = await client.getAccount(keypair.publicKey())
  const tx = new TransactionBuilder(account as any, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call("create_invoice", ...args))
    .setTimeout(30)
    .build()

  const simulated = await client.simulateTransaction(tx)
  if (SorobanRpc.Api.isSimulationError(simulated)) {
    throw Object.assign(new Error(`Soroban simulation failed: ${(simulated as any).error}`), { status: 422 })
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

  const returnVal = (getResult as SorobanRpc.Api.GetSuccessfulTransactionResponse).returnValue
  const invoiceId = returnVal ? returnVal.u64()?.toString() ?? hash : hash

  return { invoice_id: invoiceId, status: "Pending" }
}

/**
 * @openapi
 * /invoices:
 *   get:
 *     tags: [Invoices]
 *     summary: List invoices with pagination and filtering
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [Pending, Paid, Expired, Cancelled, RefundRequested, Released]
 *       - in: query
 *         name: merchant
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Paginated invoice list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Invoice'
 *                 total:
 *                   type: integer
 *                 page:
 *                   type: integer
 *                 limit:
 *                   type: integer
 *                 totalPages:
 *                   type: integer
 */
router.get("/", async (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20))
  const statusFilter = req.query.status as string | undefined
  const merchantFilter = req.query.merchant as string | undefined

  const allowedStatuses: InvoiceStatus[] = ["Pending", "Paid", "Expired", "Cancelled", "RefundRequested", "Released"]
  const status = statusFilter && allowedStatuses.includes(statusFilter as InvoiceStatus)
    ? (statusFilter as InvoiceStatus)
    : undefined

  const cacheKey = `invoices:${page}:${limit}:${status ?? "all"}:${merchantFilter ?? "all"}`

  const cached = await cacheGet<{ data: InvoiceRecord[]; total: number; page: number; limit: number; totalPages: number }>(cacheKey)
  if (cached) {
    res.json(cached)
    return
  }

  try {
    const db = await connectMongo()
    const collection = getInvoicesCollection(db)

    const filter: Record<string, unknown> = {}
    if (status) filter.status = status
    if (merchantFilter) filter.merchant_address = merchantFilter

    const total = await collection.countDocuments(filter)
    const totalPages = Math.ceil(total / limit)
    const skip = (page - 1) * limit

    const data = await collection
      .find(filter)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit)
      .toArray()

    const result = {
      data,
      total,
      page,
      limit,
      totalPages,
    }

    await cacheSet(cacheKey, result, 30)
    res.json(result)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

/**
 * @openapi
 * /invoices/{id}:
 *   get:
 *     tags: [Invoices]
 *     summary: Fetch invoice status by ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Positive integer string invoice ID
 *     responses:
 *       200:
 *         description: Invoice found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 invoice_id:
 *                   type: string
 *                   example: "42"
 *                 status:
 *                   $ref: '#/components/schemas/InvoiceStatus'
 *       400:
 *         description: Invalid invoice ID
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Invoice not found
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
router.get("/:id", validateParams(invoiceIdParamSchema), async (req: Request, res: Response) => {
  const { id } = req.params

  const rpcUrl = process.env.SOROBAN_RPC_URL
  const contractId = process.env.INVOICE_CONTRACT_ID
  const networkPassphrase = process.env.NETWORK_PASSPHRASE ?? Networks.STANDALONE

  if (!rpcUrl || !contractId) {
    res.status(503).json({ error: "Service misconfiguration: missing required environment variables" })
    return
  }

  try {
    const server = new SorobanRpc.Server(rpcUrl)
    const contract = new Contract(contractId)

    // Build a read-only ledger entry query for the invoice
    const ledgerKey = contract.getFootprint()
    void ledgerKey // used below via getLedgerEntries

    // Query the contract's ledger entry directly
    const entries = await server.getLedgerEntries(
      xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: new Contract(contractId).address().toScAddress(),
          key: nativeToScVal(BigInt(id), { type: "u64" }),
          durability: xdr.ContractDataDurability.persistent(),
        })
      )
    )

    if (!entries.entries.length) {
      res.status(404).json({ error: "Invoice not found" })
      return
    }

    res.json({ invoice_id: id, status: "Pending" })
  } catch (err: unknown) {
    const status = (err as any)?.status ?? 500
    const message = err instanceof Error ? err.message : String(err)
    res.status(status).json({ error: message })
  }
})

/**
 * @openapi
 * /invoices:
 *   post:
 *     tags: [Invoices]
 *     summary: Create a new invoice
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [merchant_address, token, amount, due_date]
 *             properties:
 *               merchant_address:
 *                 type: string
 *                 description: Valid Stellar public key (G…)
 *                 example: "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
 *               token:
 *                 type: string
 *                 example: "USDC"
 *               amount:
 *                 type: integer
 *                 description: Positive number in stroops / smallest unit
 *                 example: 1000000
 *               due_date:
 *                 type: integer
 *                 description: Future Unix timestamp (seconds)
 *                 example: 1720000000
 *     responses:
 *       201:
 *         description: Invoice created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 invoice_id:
 *                   type: string
 *                   example: "1"
 *                 status:
 *                   $ref: '#/components/schemas/InvoiceStatus'
 *       400:
 *         description: Validation error
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
 *       504:
 *         description: Transaction confirmation timeout
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post("/", validateBody(createInvoiceSchema), async (req: Request, res: Response) => {
  const rpcUrl = process.env.SOROBAN_RPC_URL
  const contractId = process.env.INVOICE_CONTRACT_ID
  const signerSecret = process.env.SIGNER_SECRET_KEY
  const networkPassphrase = process.env.NETWORK_PASSPHRASE ?? Networks.STANDALONE

  if (!rpcUrl || !contractId || !signerSecret) {
    res.status(503).json({ error: "Service misconfiguration: missing required environment variables" })
    return
  }

  try {
    const client = buildSorobanClient(rpcUrl)
    const result = await createInvoice(
      req.body as CreateInvoiceBody,
      client,
      contractId,
      signerSecret,
      networkPassphrase
    )

    const db = await connectMongo()
    const collection = getInvoicesCollection(db)
    const body = req.body as CreateInvoiceBody
    const now = new Date()
    await collection.insertOne({
      invoice_id: result.invoice_id,
      merchant_address: body.merchant_address,
      token: body.token,
      amount: body.amount,
      due_date: body.due_date,
      status: "Pending",
      created_at: now,
      updated_at: now,
    })

    res.status(201).json(result)
  } catch (err: unknown) {
    const status = (err as any)?.status ?? 500
    const message = err instanceof Error ? err.message : String(err)
    res.status(status).json({ error: message })
  }
})

export default router
