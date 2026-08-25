import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import request from "supertest"
import { createApp } from "../app.js"
import { setGraceWindow } from "../routes/invoice-settings.js"
import type { SorobanClient } from "../lib/soroban.js"
import { SorobanRpc, SorobanDataBuilder, xdr } from "stellar-sdk"

// ---------------------------------------------------------------------------
// Constants matching the validation logic in invoice-settings.ts
// ---------------------------------------------------------------------------

const MAX_GRACE_WINDOW_SECONDS = 2_592_000 // 30 days

const ENV = {
  SOROBAN_RPC_URL: "http://localhost:8000",
  INVOICE_CONTRACT_ID: "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW",
  SIGNER_SECRET_KEY: "SD6O7ZRNX5ILY5WSQR5CEWBYXRPWZNZARH3TWWPCVEC3Q5HC6D63BEJQ",
  NETWORK_PASSPHRASE: "Standalone Network ; February 2025",
}

// ---------------------------------------------------------------------------
// HTTP layer tests for POST /api/invoice/grace-window
// ---------------------------------------------------------------------------

describe("POST /api/invoice/grace-window — boundary validation", () => {
  const app = createApp()
  let envBackup: Record<string, string | undefined>

  beforeEach(() => {
    envBackup = {}
    for (const key of Object.keys(ENV)) {
      envBackup[key] = process.env[key]
      process.env[key] = ENV[key as keyof typeof ENV]
    }
  })

  afterEach(() => {
    for (const [key, val] of Object.entries(envBackup)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
  })

  // ── Invalid inputs ──────────────────────────────────────────────────────────

  it("400 when grace_window_seconds is negative", async () => {
    const res = await request(app)
      .post("/api/invoice/grace-window")
      .send({ grace_window_seconds: -1 })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/positive integer/)
  })

  it("400 when grace_window_seconds is zero", async () => {
    const res = await request(app)
      .post("/api/invoice/grace-window")
      .send({ grace_window_seconds: 0 })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/positive integer/)
  })

  it("400 when grace_window_seconds is a float", async () => {
    const res = await request(app)
      .post("/api/invoice/grace-window")
      .send({ grace_window_seconds: 1.5 })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/positive integer/)
  })

  it("400 when grace_window_seconds is a string", async () => {
    const res = await request(app)
      .post("/api/invoice/grace-window")
      .send({ grace_window_seconds: "86400" })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/positive integer/)
  })

  it("400 when grace_window_seconds is missing", async () => {
    const res = await request(app)
      .post("/api/invoice/grace-window")
      .send({})

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/positive integer/)
  })

  // ── Upper-bound validation ───────────────────────────────────────────────────

  it("400 when grace_window_seconds exceeds the 30-day maximum", async () => {
    const res = await request(app)
      .post("/api/invoice/grace-window")
      .send({ grace_window_seconds: MAX_GRACE_WINDOW_SECONDS + 1 })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/must not exceed/)
    expect(res.body.error).toContain(String(MAX_GRACE_WINDOW_SECONDS))
  })

  it("400 when grace_window_seconds is a very large number (e.g., MAX_SAFE_INTEGER)", async () => {
    const res = await request(app)
      .post("/api/invoice/grace-window")
      .send({ grace_window_seconds: Number.MAX_SAFE_INTEGER })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/must not exceed/)
  })

  // ── Valid boundary values ───────────────────────────────────────────────────

  it("reaches the Soroban layer (503 env error) with grace_window_seconds = 1", async () => {
    // Remove env so we don't accidentally call a real Soroban node,
    // but get past validation to confirm valid input is accepted.
    delete process.env.SOROBAN_RPC_URL
    const res = await request(app)
      .post("/api/invoice/grace-window")
      .send({ grace_window_seconds: 1 })

    // Should reach the env-check layer, not a validation layer
    expect(res.status).toBe(503)
    expect(res.body.error).toMatch(/misconfiguration/)
  })

  it("reaches the Soroban layer (503 env error) with grace_window_seconds = 86400 (1 day)", async () => {
    delete process.env.SOROBAN_RPC_URL
    const res = await request(app)
      .post("/api/invoice/grace-window")
      .send({ grace_window_seconds: 86_400 })

    expect(res.status).toBe(503)
    expect(res.body.error).toMatch(/misconfiguration/)
  })

  it("reaches the Soroban layer (503 env error) with grace_window_seconds at the 30-day max", async () => {
    delete process.env.SOROBAN_RPC_URL
    const res = await request(app)
      .post("/api/invoice/grace-window")
      .send({ grace_window_seconds: MAX_GRACE_WINDOW_SECONDS })

    expect(res.status).toBe(503)
    expect(res.body.error).toMatch(/misconfiguration/)
  })

  // ── Error message is consumable by GraceWindowSettings ─────────────────────

  it("error response shape has a string error field for inline display", async () => {
    const res = await request(app)
      .post("/api/invoice/grace-window")
      .send({ grace_window_seconds: -100 })

    expect(res.body).toHaveProperty("error")
    expect(typeof res.body.error).toBe("string")
    expect(res.body.error.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Unit tests for setGraceWindow (Soroban interaction, injectable client)
// ---------------------------------------------------------------------------

const PARSED_SIM_SUCCESS = {
  _parsed: true,
  latestLedger: 1,
  events: [],
  minResourceFee: "0",
  transactionData: new SorobanDataBuilder(),
  result: { auth: [], retval: xdr.ScVal.scvVoid() },
}

const MERCHANT_ADDRESS = "GDR7WUDWIKWVBCUBVYLOGT3TJF5FGNQU5U7TACDDA2ZIQUETGGUET5XT"

const fakeAccount = {
  accountId: () => MERCHANT_ADDRESS,
  sequenceNumber: () => "100",
  incrementSequenceNumber: vi.fn(),
}

describe("setGraceWindow — Soroban integration", () => {
  const fakeEnv = {
    rpcUrl: "http://localhost:8000",
    invoiceContractId: ENV.INVOICE_CONTRACT_ID,
    signerSecret: ENV.SIGNER_SECRET_KEY,
    networkPassphrase: ENV.NETWORK_PASSPHRASE,
  }

  it("returns grace_window_seconds and tx_hash on success", async () => {
    const mockClient: SorobanClient = {
      getAccount: vi.fn().mockResolvedValue(fakeAccount),
      simulateTransaction: vi.fn().mockResolvedValue(PARSED_SIM_SUCCESS),
      sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING", hash: "grace-hash" }),
      getTransaction: vi.fn().mockResolvedValue({
        status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
        latestLedger: 1,
        latestLedgerCloseTime: 0,
        oldestLedger: 1,
        oldestLedgerCloseTime: 0,
      }),
    } as unknown as SorobanClient

    const result = await setGraceWindow(86_400, fakeEnv, mockClient)

    expect(result).toMatchObject({
      grace_window_seconds: 86_400,
      tx_hash: "grace-hash",
    })
  })
})
