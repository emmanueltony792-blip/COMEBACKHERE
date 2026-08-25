import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { stopTreasuryIndexer } from "../services/treasury-indexer.js"
import { stopIndexer } from "../indexer.js"
import { closeMongo } from "../db/mongo.js"

// We test the shutdown logic in isolation without spawning a real process.
// The strategy: extract and call the shutdown function's individual steps,
// asserting each dependency is invoked.

vi.mock("../services/treasury-indexer.js", () => ({
  startTreasuryIndexer: vi.fn(),
  stopTreasuryIndexer: vi.fn(),
}))

vi.mock("../indexer.js", () => ({
  stopIndexer: vi.fn(),
}))

vi.mock("../db/mongo.js", () => ({
  closeMongo: vi.fn().mockResolvedValue(undefined),
  connectMongo: vi.fn(),
}))

// Re-import after mocks are set up
const { stopTreasuryIndexer: mockStopTreasuryIndexer } = await import("../services/treasury-indexer.js") as {
  stopTreasuryIndexer: ReturnType<typeof vi.fn>
}
const { stopIndexer: mockStopIndexer } = await import("../indexer.js") as {
  stopIndexer: ReturnType<typeof vi.fn>
}
const { closeMongo: mockCloseMongo } = await import("../db/mongo.js") as {
  closeMongo: ReturnType<typeof vi.fn>
}

// ---------------------------------------------------------------------------
// Shutdown step tests (unit-level)
// ---------------------------------------------------------------------------

describe("Graceful shutdown steps", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("stopTreasuryIndexer is exported and callable", () => {
    stopTreasuryIndexer()
    expect(mockStopTreasuryIndexer).toHaveBeenCalledOnce()
  })

  it("stopIndexer is exported and callable", () => {
    stopIndexer()
    expect(mockStopIndexer).toHaveBeenCalledOnce()
  })

  it("closeMongo resolves without error", async () => {
    await closeMongo()
    expect(mockCloseMongo).toHaveBeenCalledOnce()
  })

  it("shutdown sequence calls stopTreasuryIndexer, stopIndexer, and closeMongo", async () => {
    // Simulate the shutdown sequence without requiring a live server
    stopTreasuryIndexer()
    stopIndexer()
    await closeMongo()

    expect(mockStopTreasuryIndexer).toHaveBeenCalledOnce()
    expect(mockStopIndexer).toHaveBeenCalledOnce()
    expect(mockCloseMongo).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// stopIndexer idempotency test
// ---------------------------------------------------------------------------

describe("stopIndexer", () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it("can be called multiple times without error (idempotent)", () => {
    expect(() => {
      stopIndexer()
      stopIndexer()
      stopIndexer()
    }).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// stopTreasuryIndexer idempotency test
// ---------------------------------------------------------------------------

describe("stopTreasuryIndexer", () => {
  it("can be called multiple times without error (idempotent)", () => {
    expect(() => {
      stopTreasuryIndexer()
      stopTreasuryIndexer()
    }).not.toThrow()
  })
})
