/**
 * OpenAPI / Swagger spec — Issue #218
 *
 * Generates the full spec from inline JSDoc annotations on each route.
 * Served at GET /api-docs/swagger.json (raw JSON) and GET /api-docs (UI).
 */

import swaggerJsdoc from "swagger-jsdoc"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: "3.0.3",
    info: {
      title: "COMEBACKHERE API",
      version: "1.0.0",
      description:
        "REST API for the COMEBACKHERE Protocol — the Stripe for Stellar.\n\n" +
        "See [docs/api-reference.md](https://github.com/dreamgeneX/COMEBACKHERE/blob/main/docs/api-reference.md) for the full hand-written reference.",
      contact: {
        name: "dreamgene",
        url: "https://github.com/dreamgeneX",
      },
    },
    servers: [
      { url: "http://localhost:3000", description: "Local development" },
    ],
    components: {
      schemas: {
        ErrorResponse: {
          type: "object",
          properties: {
            error: { type: "string", example: "Human-readable description of the error." },
          },
          required: ["error"],
        },
        InvoiceStatus: {
          type: "string",
          enum: ["Pending", "Paid", "Expired", "Cancelled"],
        },
        SettlementStatus: {
          type: "string",
          enum: ["Pending", "Executed", "PartiallyExecuted", "OnHold", "Cancelled"],
        },
        SettlementRecord: {
          type: "object",
          properties: {
            id: { type: "integer", example: 1 },
            merchant_address: { type: "string", example: "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" },
            amount: { type: "string", example: "5000000" },
            token: { type: "string", example: "USDC" },
            approvals: { type: "array", items: { type: "string" } },
            approval_weight: { type: "integer", example: 2 },
            status: { $ref: "#/components/schemas/SettlementStatus" },
            hold_reason: { type: "string", nullable: true },
          },
        },
      },
    },
    tags: [
      { name: "Health", description: "Service health checks" },
      { name: "Invoices", description: "Invoice creation and status" },
      { name: "Disputes", description: "Dispute management" },
      { name: "Treasury", description: "Settlement and treasury operations" },
      { name: "Invoice Settings", description: "Grace window configuration" },
    ],
  },
  // Glob must resolve at spec-generation time; use absolute path
  apis: [join(__dirname, "routes", "*.js"), join(__dirname, "routes", "*.ts")],
}

export const openapiSpec = swaggerJsdoc(options)
