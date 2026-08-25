import express from "express"
import swaggerUi from "swagger-ui-express"
import invoicesRouter from "./routes/invoices.js"
import complianceRouter from "./routes/compliance.js"
import releaseEscrowRouter from "./routes/release-escrow.js"
import treasuryRouter from "./routes/treasury.js"
import invoiceSettingsRouter from "./routes/invoice-settings.js"
import thresholdRouter from "./routes/threshold.js"
import disputesRouter from "./routes/disputes.js"
import analyticsRouter from "./routes/analytics.js"
import { rateLimitMiddleware } from "./middleware/rateLimiter.js"
import { correlationIdMiddleware } from "./middleware/correlationId.js"
import { openapiSpec } from "./openapi.js"

export function createApp() {
  const app = express()
  app.use(express.json())
  // Attach / propagate X-Request-Id before any other middleware so every log
  // line and downstream call can reference the same correlation ID.
  app.use(correlationIdMiddleware)
  app.use(rateLimitMiddleware)

  // ── Health ──────────────────────────────────────────────────────────────────
  app.get("/health", (_req, res) => res.json({ status: "ok" }))

  // ── OpenAPI spec (Issue #218) ───────────────────────────────────────────────
  // Raw JSON spec at a stable, machine-readable URL
  app.get("/api-docs/swagger.json", (_req, res) => {
    res.setHeader("Content-Type", "application/json")
    res.json(openapiSpec)
  })
  // Swagger UI
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(openapiSpec))

  // ── Application routes ──────────────────────────────────────────────────────
  app.use("/invoices", invoicesRouter)
  app.use("/invoices", releaseEscrowRouter)
  app.use("/compliance", complianceRouter)
  app.use("/api/treasury", treasuryRouter)
  app.use("/api/invoice", invoiceSettingsRouter)
  app.use("/api/treasury", thresholdRouter)
  app.use("/disputes", disputesRouter)
  app.use("/api/analytics", analyticsRouter)
  return app
}
