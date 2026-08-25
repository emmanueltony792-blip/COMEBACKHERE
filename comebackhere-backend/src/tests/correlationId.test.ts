import { describe, it, expect } from "vitest"
import request from "supertest"
import { createApp } from "../app.js"

// Attach a simple probe route so we can test the middleware in isolation
// without hitting any real route logic.
function createTestApp() {
  const app = createApp()
  app.get("/probe", (_req, res) => {
    res.status(200).json({ requestId: res.locals.requestId })
  })
  return app
}

describe("correlationIdMiddleware", () => {
  it("adds an X-Request-Id header to the response", async () => {
    const app = createTestApp()
    const res = await request(app).get("/probe")
    expect(res.headers["x-request-id"]).toBeDefined()
    expect(typeof res.headers["x-request-id"]).toBe("string")
    expect(res.headers["x-request-id"].length).toBeGreaterThan(0)
  })

  it("generates a new UUID when the client does not supply X-Request-Id", async () => {
    const app = createTestApp()
    const res = await request(app).get("/probe")
    // UUID v4 pattern
    expect(res.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })

  it("preserves a client-supplied X-Request-Id rather than overwriting it", async () => {
    const clientId = "my-trace-id-12345"
    const app = createTestApp()
    const res = await request(app).get("/probe").set("X-Request-Id", clientId)

    expect(res.headers["x-request-id"]).toBe(clientId)
  })

  it("stores the request ID in res.locals.requestId for downstream handlers", async () => {
    const clientId = "locals-check-id"
    const app = createTestApp()
    const res = await request(app).get("/probe").set("X-Request-Id", clientId)

    expect(res.body.requestId).toBe(clientId)
  })

  it("generates a different ID for each request when no client ID is supplied", async () => {
    const app = createTestApp()
    const [res1, res2] = await Promise.all([
      request(app).get("/probe"),
      request(app).get("/probe"),
    ])

    expect(res1.headers["x-request-id"]).not.toBe(res2.headers["x-request-id"])
  })
})
