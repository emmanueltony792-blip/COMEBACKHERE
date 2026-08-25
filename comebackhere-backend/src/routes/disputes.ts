import { Router, type Request, type Response } from "express"
import { validateBody } from "../middleware/validate.js"
import { voteBodySchema, createDisputeSchema } from "../schemas/index.js"

const router = Router()

// In-memory vote store (keyed by dispute id)
// Shape: { [disputeId]: { votes: Map<signer, vote>, claimant_weight: number, counterparty_weight: number, outcome: string | null } }
interface DisputeVoteState {
  votes: Map<string, string>
  claimant_weight: number
  counterparty_weight: number
  outcome: string | null
}
const disputeVotes = new Map<string, DisputeVoteState>()

const VOTE_THRESHOLD = Number(process.env.DISPUTE_VOTE_THRESHOLD ?? 2)

type VoteValue = "ResolvedClaimant" | "ResolvedCounterparty"

/**
 * @openapi
 * /disputes/{id}/vote:
 *   post:
 *     tags: [Disputes]
 *     summary: Cast a vote on a dispute
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Dispute ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [signer_address, vote]
 *             properties:
 *               signer_address:
 *                 type: string
 *                 description: Valid Stellar public key of the voting signer
 *               vote:
 *                 type: string
 *                 enum: [ResolvedClaimant, ResolvedCounterparty]
 *               weight:
 *                 type: integer
 *                 default: 1
 *     responses:
 *       200:
 *         description: Vote recorded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 dispute_id:
 *                   type: string
 *                 signer_address:
 *                   type: string
 *                 vote:
 *                   type: string
 *                 claimant_weight:
 *                   type: integer
 *                 counterparty_weight:
 *                   type: integer
 *                 outcome:
 *                   type: string
 *                   nullable: true
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Dispute already resolved or signer already voted
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post("/:id/vote", validateBody(voteBodySchema), async (req: Request, res: Response) => {
  const disputeId = req.params.id
  const { signer_address, vote, weight } = req.body as {
    signer_address: string
    vote: "ResolvedClaimant" | "ResolvedCounterparty"
    weight: number
  }

  const state: DisputeVoteState = disputeVotes.get(disputeId) ?? {
    votes: new Map(),
    claimant_weight: 0,
    counterparty_weight: 0,
    outcome: null,
  }

  if (state.outcome !== null) {
    res.status(409).json({ error: "Dispute already resolved", outcome: state.outcome })
    return
  }

  if (state.votes.has(signer_address)) {
    res.status(409).json({ error: "Signer has already voted on this dispute" })
    return
  }

  state.votes.set(signer_address, vote)
  if (vote === "ResolvedClaimant") {
    state.claimant_weight += weight
  } else {
    state.counterparty_weight += weight
  }

  const threshold = VOTE_THRESHOLD
  const resolution_weight = state.claimant_weight + state.counterparty_weight

  if (state.claimant_weight >= threshold) {
    state.outcome = "ResolvedClaimant"
  } else if (state.counterparty_weight >= threshold) {
    state.outcome = "ResolvedCounterparty"
  }

  disputeVotes.set(disputeId, state)

  res.status(200).json({
    dispute_id: disputeId,
    signer_address,
    vote,
    claimant_weight: state.claimant_weight,
    counterparty_weight: state.counterparty_weight,
    resolution_weight,
    threshold,
    outcome: state.outcome,
  })
})

export interface CreateDisputeBody {
  /** Stellar public key of the party raising the dispute (claimant). */
  claimant_address: string
  /** ID of the settlement this dispute is linked to. */
  settlement_id: string
  /** Optional human-readable reason for the dispute. */
  reason?: string
}

/**
 * @openapi
 * /disputes:
 *   post:
 *     tags: [Disputes]
 *     summary: Raise a dispute linked to a settlement
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [claimant_address, settlement_id]
 *             properties:
 *               claimant_address:
 *                 type: string
 *                 description: Valid Stellar public key of the disputing party
 *               settlement_id:
 *                 type: string
 *                 description: Positive integer string identifying the settlement
 *                 example: "5"
 *               reason:
 *                 type: string
 *                 description: Human-readable reason for the dispute
 *     responses:
 *       201:
 *         description: Dispute raised; settlement transitioned to OnHold
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 dispute_id:
 *                   type: string
 *                   example: "5-1720000000000"
 *                 settlement_id:
 *                   type: string
 *                   example: "5"
 *                 claimant_address:
 *                   type: string
 *                 status:
 *                   type: string
 *                   example: "Raised"
 *                 settlement_status:
 *                   type: string
 *                   example: "OnHold"
 *       400:
 *         description: Validation error
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
router.post("/", validateBody(createDisputeSchema), async (req: Request, res: Response) => {
  const body = req.body as CreateDisputeBody

  const rpcUrl = process.env.SOROBAN_RPC_URL
  const settlementContractId = process.env.SETTLEMENT_CONTRACT_ID
  const signerSecret = process.env.SIGNER_SECRET_KEY

  if (!rpcUrl || !settlementContractId || !signerSecret) {
    res.status(503).json({ error: "Service misconfiguration: missing required environment variables" })
    return
  }

  const settlementId = body.settlement_id
  const claimantAddress = body.claimant_address

  try {
    // In production this would call raise_dispute on the settlement contract via Soroban RPC.
    // The contract transitions the settlement to OnHold atomically. Here we return the
    // expected shape so downstream clients can integrate without a live node.
    const disputeId = `${settlementId}-${Date.now()}`

    res.status(201).json({
      dispute_id: disputeId,
      settlement_id: settlementId,
      claimant_address: claimantAddress,
      status: "Raised",
      settlement_status: "OnHold",
    })
  } catch (err: unknown) {
    const status = (err as any)?.status ?? 500
    const message = err instanceof Error ? err.message : String(err)
    res.status(status).json({ error: message })
  }
})

export default router
