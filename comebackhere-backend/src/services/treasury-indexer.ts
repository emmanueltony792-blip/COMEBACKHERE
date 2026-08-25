import { xdr } from "stellar-sdk"
import {
  buildSorobanClient,
  type SorobanClient,
} from "../lib/soroban.js"
import {
  connectMongo,
  getCursorsCollection,
  getSettlementsCollection,
  type SettlementRecord,
} from "../db/mongo.js"

const CURSOR_ID = "treasury_settlement_events"
const POLL_INTERVAL_MS = 5_000
const EVENT_LIMIT = 100

function topicSymbol(topic: xdr.ScVal[] | undefined, index: number): string | null {
  return topic?.[index]?.sym()?.toString() ?? null
}

function topicU64(topic: xdr.ScVal[] | undefined, index: number): bigint {
  return BigInt(topic?.[index]?.u64()?.toString() ?? "0")
}

function topicAddress(topic: xdr.ScVal[] | undefined, index: number): string {
  return topic?.[index]?.address()?.toString() ?? ""
}

function valueU64(value: xdr.ScVal | undefined, index: number): bigint {
  const vec = value?.vec()
  return BigInt(vec?.[index]?.u64()?.toString() ?? "0")
}

function valueAddress(value: xdr.ScVal | undefined, index: number): string {
  const vec = value?.vec()
  return vec?.[index]?.address()?.toString() ?? ""
}

async function loadCursor(database: Awaited<ReturnType<typeof connectMongo>>) {
  const cursors = getCursorsCollection(database)
  const existing = await cursors.findOne({ _id: CURSOR_ID })
  return existing ?? { _id: CURSOR_ID, paging_token: null, last_ledger: 0, updated_at: new Date() }
}

async function saveCursor(
  database: Awaited<ReturnType<typeof connectMongo>>,
  pagingToken: string | null,
  lastLedger: number,
  newEventIds: string[] = [],
) {
  const cursors = getCursorsCollection(database)
  const update: Record<string, unknown> = {
    paging_token: pagingToken,
    last_ledger: lastLedger,
    updated_at: new Date(),
  }

  if (newEventIds.length > 0) {
    await cursors.updateOne(
      { _id: CURSOR_ID },
      {
        $set: update,
        // Keep only the most recent 1 000 event IDs to bound document size
        $push: {
          processed_event_ids: {
            $each: newEventIds,
            $slice: -1000,
          },
        } as any,
      },
      { upsert: true },
    )
  } else {
    await cursors.updateOne(
      { _id: CURSOR_ID },
      { $set: update },
      { upsert: true },
    )
  }
}

async function processSettlementProposed(
  settlements: ReturnType<typeof getSettlementsCollection>,
  settlementId: number,
  token: string,
  amount: bigint,
  merchant: string,
  txHash: string,
) {
  await settlements.updateOne(
    { id: settlementId },
    {
      $setOnInsert: {
        id: settlementId,
        approvals: [],
        approval_weight: 0,
        status: "Pending" as const,
        hold_reason: null,
      },
      $set: {
        merchant_address: merchant,
        amount: amount.toString(),
        token,
        proposed_tx_hash: txHash,
        updated_at: new Date(),
      },
    },
    { upsert: true },
  )
}

async function processSettlementApproved(
  settlements: ReturnType<typeof getSettlementsCollection>,
  settlementId: number,
  signer: string,
  newWeight: bigint,
) {
  await settlements.updateOne(
    { id: settlementId },
    {
      $addToSet: { approvals: signer },
      $set: {
        approval_weight: Number(newWeight),
        updated_at: new Date(),
      },
      $setOnInsert: {
        merchant_address: "",
        amount: "0",
        token: "",
        status: "Pending" as const,
        hold_reason: null,
      },
    },
    { upsert: true },
  )
}

async function processSettlementExecuted(
  settlements: ReturnType<typeof getSettlementsCollection>,
  settlementId: number,
  txHash: string,
) {
  await settlements.updateOne(
    { id: settlementId },
    {
      $set: {
        status: "Executed" as SettlementRecord["status"],
        executed_tx_hash: txHash,
        updated_at: new Date(),
      },
      $setOnInsert: {
        merchant_address: "",
        amount: "0",
        token: "",
        approvals: [],
        approval_weight: 0,
        hold_reason: null,
      },
    },
    { upsert: true },
  )
}

/**
 * Build a deterministic, unique identifier for an on-chain event so that
 * replaying an overlapping window (e.g. after a reorg or indexer restart)
 * never applies the same side-effect twice.
 *
 * Format: "<pagingToken>" when available (Soroban paging tokens already encode
 * ledger + tx index + event index), falling back to "<txHash>:<eventType>:<settlementId>".
 */
export function buildEventId(
  pagingToken: string | undefined,
  txHash: string,
  eventType: string,
  settlementId: number,
): string {
  if (pagingToken) return pagingToken
  return `${txHash}:${eventType}:${settlementId}`
}

export async function processIndexerBatch(
  client: SorobanClient,
  treasuryContractId: string,
  database: Awaited<ReturnType<typeof connectMongo>>,
): Promise<number> {
  const settlements = getSettlementsCollection(database)
  const cursor = await loadCursor(database)

  let startLedger = cursor.last_ledger > 0 ? cursor.last_ledger : undefined
  if (!startLedger) {
    const latest = await client.getLatestLedger()
    startLedger = Math.max(1, latest.sequence - 100)
  }

  const response = await client.getEvents({
    startLedger,
    filters: [{ type: "contract", contractIds: [treasuryContractId] }],
    limit: EVENT_LIMIT,
    ...(cursor.paging_token ? { cursor: cursor.paging_token } : {}),
  })

  // Collect the set of already-processed event IDs stored in the cursor document
  // so we can skip duplicates that appear when replaying an overlapping window
  // after a reorg or an indexer restart that resumed from an earlier ledger.
  const processedIds: Set<string> = new Set(cursor.processed_event_ids ?? [])

  let processed = 0
  let lastPagingToken = cursor.paging_token
  const newEventIds: string[] = []

  for (const event of response.events ?? []) {
    const eventType = topicSymbol(event.topic, 0)
    const txHash = event.txHash ?? ""
    lastPagingToken = event.pagingToken ?? lastPagingToken

    if (
      eventType !== "settlement_proposed" &&
      eventType !== "settlement_approved" &&
      eventType !== "settlement_executed"
    ) {
      continue
    }

    const settlementId = Number(valueU64(event.value, 0))
    const eventId = buildEventId(event.pagingToken, txHash, eventType, settlementId)

    // De-duplicate: skip events we have already applied (reorg / replay protection)
    if (processedIds.has(eventId)) {
      console.log(`[treasury-indexer] skipping duplicate event id=${eventId}`)
      continue
    }

    if (eventType === "settlement_proposed") {
      const token = valueAddress(event.value, 1)
      const amount = valueU64(event.value, 2)
      const merchant = valueAddress(event.value, 3)
      await processSettlementProposed(settlements, settlementId, token, amount, merchant, txHash)
    } else if (eventType === "settlement_approved") {
      const signer = valueAddress(event.value, 1)
      const newWeight = valueU64(event.value, 3)
      await processSettlementApproved(settlements, settlementId, signer, newWeight)
    } else if (eventType === "settlement_executed") {
      await processSettlementExecuted(settlements, settlementId, txHash)
    }

    processedIds.add(eventId)
    newEventIds.push(eventId)
    processed++
  }

  const lastLedger = response.latestLedger ?? cursor.last_ledger
  await saveCursor(database, lastPagingToken, lastLedger, newEventIds)

  if (processed > 0) {
    console.log(
      `[treasury-indexer] processed ${processed} event(s); cursor ledger=${lastLedger}`,
    )
  }

  return processed
}

let indexerTimer: ReturnType<typeof setInterval> | null = null

export function startTreasuryIndexer(): void {
  if (indexerTimer) return

  const rpcUrl = process.env.SOROBAN_RPC_URL
  const treasuryContractId = process.env.TREASURY_CONTRACT_ID

  if (!rpcUrl || !treasuryContractId) {
    console.warn(
      "[treasury-indexer] skipped: SOROBAN_RPC_URL and TREASURY_CONTRACT_ID required",
    )
    return
  }

  const client = buildSorobanClient(rpcUrl)

  const tick = async () => {
    try {
      const database = await connectMongo()
      await processIndexerBatch(client, treasuryContractId, database)
    } catch (err) {
      console.error("[treasury-indexer] error:", err instanceof Error ? err.message : err)
    }
  }

  void tick()
  indexerTimer = setInterval(() => void tick(), POLL_INTERVAL_MS)
  console.log("[treasury-indexer] started")
}

export function stopTreasuryIndexer(): void {
  if (indexerTimer) {
    clearInterval(indexerTimer)
    indexerTimer = null
  }
}
