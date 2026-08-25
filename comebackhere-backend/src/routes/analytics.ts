import { Router, type Request, type Response } from "express"
import { validateQuery } from "../middleware/validate.js"
import { analyticsQuerySchema } from "../schemas/index.js"

const router = Router()

interface InvoiceMetrics {
  pending: number
  paid: number
  cancelled: number
  expired: number
  refund_requested: number
}

interface AnalyticsData {
  invoices: InvoiceMetrics
  settled_volume: Array<{
    token: string
    volume: number
  }>
  open_disputes: number
  compliance_blocks: number
  settlement_throughput: number
}

/**
 * GET /api/analytics/metrics
 * Returns aggregated protocol metrics for the admin dashboard
 *
 * Query parameters:
 * - start_date: Unix timestamp (seconds) for start of range
 * - end_date: Unix timestamp (seconds) for end of range
 *
 * Returns mock/aggregated data that would typically come from:
 * - Invoice contract state (invoice counts by status)
 * - Treasury contract events (settled volumes)
 * - Disputes contract state (open disputes)
 * - Compliance contract state (blocks)
 */
router.get("/metrics", validateQuery(analyticsQuerySchema), async (req: Request, res: Response) => {
  try {
    // In production, this would:
    // 1. Query the invoice contract for invoice counts by status
    // 2. Query treasury contract for settled volumes by token
    // 3. Query disputes contract for open dispute count
    // 4. Query compliance contract for active blocks
    // 5. Apply date filters if provided
    //
    // For now, return realistic mock data that can be seeded/tested
    const analyticsData: AnalyticsData = {
      invoices: {
        pending: 24,
        paid: 156,
        cancelled: 12,
        expired: 8,
        refund_requested: 3,
      },
      settled_volume: [
        { token: "USDC", volume: 184250.5 },
        { token: "XLM", volume: 52100.0 },
        { token: "EURC", volume: 12450.75 },
      ],
      open_disputes: 7,
      compliance_blocks: 3,
      settlement_throughput: 89, // settled invoices in period
    }

    res.json(analyticsData)
  } catch (error) {
    console.error("Error fetching analytics metrics:", error)
    res.status(500).json({ error: "Failed to fetch analytics metrics" })
  }
})

export default router
