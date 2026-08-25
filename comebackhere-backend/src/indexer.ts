/**
 * Invoice event indexer — #69
 *
 * Polls Soroban for invoice contract events (invoice_created, invoice_paid,
 * invoice_expired, invoice_cancelled, escrow_released) using cursor-based
 * pagination so missed events and re-org recovery are handled automatically.
 *
 * Usage (standalone):
 *   SOROBAN_RPC_URL=... INVOICE_CONTRACT_ID=... node dist/indexer.js
 *
 * Usage (embedded): call startIndexer() from index.ts or a worker.
 */

import { SorobanRpc, xdr } from "stellar-sdk"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InvoiceEventType =
  | "invoice_created"
  | "invoice_paid"
  | "invoice_expired"
  | "invoice_cancelled"
  | "escrow_released"

export interface InvoiceStateTransition {
  event_type: InvoiceEventType
  invoice_id: string
  ledger: number
  ledger_closed_at: string
  transaction_hash: string
  contract_id: string
  raw_topics: string[]
  raw_value: string
}

const TRACKED_EVENTS = new Set<string>([
  "invoice_created",
  "invoice_paid",
  "invoice_expired",
  "invoice_cancelled",
  "escrow_released",
])

// ---------------------------------------------------------------------------
// Cursor persistence (in-memory with optional env override for restarts)
// ---------------------------------------------------------------------------

let cursor: string = process.env.INDEXER_START_CURSOR ?? "0"

function saveCursor(next: string): void {
  cursor = next
  // In production swap this for a DB or Redis write so restarts resume cleanly.
  // e.g.: await redis.set("invoice_indexer_cursor", next)
}

// ---------------------------------------------------------------------------
// Event parsing
// ---------------------------------------------------------------------------

function parseEventType(topics: xdr.ScVal[]): InvoiceEventType | null {
  // Soroban contract events encode the event name as the first topic symbol.
  const name = topics[0]?.sym()?.toString()
  if (!name || !TRACKED_EVENTS.has(name)) return null
  return name as InvoiceEventType
}

function parseInvoiceId(topics: xdr.ScVal[]): string {
  // Convention: second topic is the invoice_id (u32 or u64).
  const id = topics[1]?.u32() ?? topics[1]?.u64()
  return id?.toString() ?? "unknown"
}

function scValToString(val: xdr.ScVal): string {
  try {
    return val.toXDR("base64")
  } catch {
    return ""
  }
}

// ---------------------------------------------------------------------------
// Persistence stub
// ---------------------------------------------------------------------------

/**
 * Persist a state transition record. Replace with real DB writes in production.
 * e.g.: await db.invoiceEvents.insert(transition)
 */
export function persistTransition(transition: InvoiceStateTransition): void {
  console.log(
    `[indexer] ${transition.event_type} invoice_id=${transition.invoice_id}` +
    ` ledger=${transition.ledger} tx=${transition.transaction_hash}`
  )
}

// ---------------------------------------------------------------------------
// Core poll loop
// ---------------------------------------------------------------------------

export async function pollOnce(
  server: SorobanRpc.Server,
  contractId: string
): Promise<void> {
  const response = await (server as any).getEvents({
    startLedger: cursor === "0" ? undefined : undefined,
    cursor: cursor === "0" ? undefined : cursor,
    filters: [
      {
        type: "contract",
        contractIds: [contractId],
      },
    ],
    limit: 100,
  })

  const events: any[] = response?.events ?? []

  for (const event of events) {
    const topics: xdr.ScVal[] = (event.topic ?? []).map((t: string) =>
      xdr.ScVal.fromXDR(t, "base64")
    )
    const eventType = parseEventType(topics)
    if (!eventType) continue

    const rawValue = event.value?.xdr ?? ""
    const transition: InvoiceStateTransition = {
      event_type: eventType,
      invoice_id: parseInvoiceId(topics),
      ledger: event.ledger,
      ledger_closed_at: event.ledgerClosedAt ?? new Date().toISOString(),
      transaction_hash: event.txHash ?? "",
      contract_id: contractId,
      raw_topics: (event.topic ?? []) as string[],
      raw_value: rawValue,
    }

    persistTransition(transition)
  }

  // Advance cursor to the last seen event's paging token for re-org safety.
  if (events.length > 0) {
    saveCursor(events[events.length - 1].pagingToken)
  }
}

// ---------------------------------------------------------------------------
// Start function — exported for embedding; also runs as CLI entry point
// ---------------------------------------------------------------------------

/** Handle to the running poll loop, used by stop() to prevent new polls. */
let stopped = false
let activeTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Stops the indexer poll loop. Safe to call multiple times.
 * Does not interrupt an in-flight pollOnce() call; it prevents scheduling
 * the next one so any active poll completes cleanly before the process exits.
 */
export function stopIndexer(): void {
  stopped = true
  if (activeTimer !== null) {
    clearTimeout(activeTimer)
    activeTimer = null
  }
}

export async function startIndexer(options?: {
  rpcUrl?: string
  contractId?: string
  pollIntervalMs?: number
  onError?: (err: unknown) => void
}): Promise<void> {
  const rpcUrl = options?.rpcUrl ?? process.env.SOROBAN_RPC_URL
  const contractId = options?.contractId ?? process.env.INVOICE_CONTRACT_ID
  const pollIntervalMs = options?.pollIntervalMs ?? 5_000

  if (!rpcUrl || !contractId) {
    throw new Error("startIndexer: SOROBAN_RPC_URL and INVOICE_CONTRACT_ID are required")
  }

  const server = new SorobanRpc.Server(rpcUrl)

  console.log(`[indexer] starting — contract=${contractId} cursor=${cursor} interval=${pollIntervalMs}ms`)

  const loop = async () => {
    if (stopped) return
    try {
      await pollOnce(server, contractId)
    } catch (err) {
      const handler = options?.onError ?? ((e) => console.error("[indexer] poll error", e))
      handler(err)
    }
    if (!stopped) {
      activeTimer = setTimeout(loop, pollIntervalMs)
    }
  }

  // Reset stopped flag in case startIndexer is called again after stopIndexer
  stopped = false
  loop()
}

// Run as standalone entry point
if (import.meta.url === new URL(process.argv[1], import.meta.url).href) {
  startIndexer().catch((err) => {
    console.error("[indexer] fatal", err)
    process.exit(1)
  })
}
