import { MongoClient, type Db, type Collection } from "mongodb"

export type InvoiceStatus = "Pending" | "Paid" | "Expired" | "Cancelled" | "RefundRequested" | "Released"

export interface InvoiceRecord {
  invoice_id: string
  merchant_address: string
  token: string
  amount: number
  due_date: number
  status: InvoiceStatus
  created_at: Date
  updated_at: Date
}

export interface SettlementRecord {
  id: number
  merchant_address: string
  amount: string
  token: string
  approvals: string[]
  approval_weight: number
  status: "Pending" | "Executed" | "PartiallyExecuted" | "OnHold" | "Cancelled"
  hold_reason: string | null
  updated_at: Date
  proposed_tx_hash?: string
  executed_tx_hash?: string
}

export interface IndexerCursor {
  _id: string
  paging_token: string | null
  last_ledger: number
  updated_at: Date
  /** Event IDs already applied — used for reorg / replay deduplication. */
  processed_event_ids?: string[]
}

let client: MongoClient | null = null
let db: Db | null = null

export async function connectMongo(): Promise<Db> {
  if (db) return db

  const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017"
  const dbName = process.env.MONGODB_DB ?? "comebackhere"

  client = new MongoClient(uri)
  await client.connect()
  db = client.db(dbName)

  const settlements = db.collection<SettlementRecord>("settlements")
  await settlements.createIndex({ id: 1 }, { unique: true })
  await settlements.createIndex({ status: 1 })

  const invoices = db.collection<InvoiceRecord>("invoices")
  await invoices.createIndex({ invoice_id: 1 }, { unique: true })
  await invoices.createIndex({ status: 1 })
  await invoices.createIndex({ merchant_address: 1 })
  await invoices.createIndex({ status: 1, merchant_address: 1 })

  const cursors = db.collection<IndexerCursor>("indexer_cursors")
  await cursors.createIndex({ _id: 1 }, { unique: true })

  return db
}

export function getInvoicesCollection(database: Db): Collection<InvoiceRecord> {
  return database.collection<InvoiceRecord>("invoices")
}

export function getSettlementsCollection(database: Db): Collection<SettlementRecord> {
  return database.collection<SettlementRecord>("settlements")
}

export function getCursorsCollection(database: Db): Collection<IndexerCursor> {
  return database.collection<IndexerCursor>("indexer_cursors")
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close()
    client = null
    db = null
  }
}
