import { describe, it, expect } from "vitest"
import request from "supertest"
import { createApp } from "../app.js"

describe("GET /api-docs/swagger.json — OpenAPI spec endpoint", () => {
  const app = createApp()

  it("returns 200 with Content-Type application/json", async () => {
    const res = await request(app).get("/api-docs/swagger.json")
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toMatch(/application\/json/)
  })

  it("returns a valid OpenAPI 3.0 object with required top-level fields", async () => {
    const res = await request(app).get("/api-docs/swagger.json")
    const spec = res.body

    // Top-level OpenAPI object
    expect(spec).toHaveProperty("openapi")
    expect(spec.openapi).toMatch(/^3\.0\./)
    expect(spec).toHaveProperty("info")
    expect(spec).toHaveProperty("paths")
  })

  it("spec info block has title and version", async () => {
    const res = await request(app).get("/api-docs/swagger.json")
    const spec = res.body

    expect(spec.info.title).toBe("COMEBACKHERE API")
    expect(spec.info.version).toBeDefined()
  })

  it("spec covers the /invoices POST endpoint", async () => {
    const res = await request(app).get("/api-docs/swagger.json")
    const spec = res.body

    expect(spec.paths).toHaveProperty("/invoices")
    expect(spec.paths["/invoices"]).toHaveProperty("post")
  })

  it("spec covers the /invoices/{id} GET endpoint", async () => {
    const res = await request(app).get("/api-docs/swagger.json")
    const spec = res.body

    expect(spec.paths).toHaveProperty("/invoices/{id}")
    expect(spec.paths["/invoices/{id}"]).toHaveProperty("get")
  })

  it("spec covers the /disputes POST endpoint", async () => {
    const res = await request(app).get("/api-docs/swagger.json")
    const spec = res.body

    expect(spec.paths).toHaveProperty("/disputes")
    expect(spec.paths["/disputes"]).toHaveProperty("post")
  })

  it("spec covers the /api/invoice/grace-window GET and POST endpoints", async () => {
    const res = await request(app).get("/api-docs/swagger.json")
    const spec = res.body

    expect(spec.paths).toHaveProperty("/api/invoice/grace-window")
    expect(spec.paths["/api/invoice/grace-window"]).toHaveProperty("get")
    expect(spec.paths["/api/invoice/grace-window"]).toHaveProperty("post")
  })

  it("spec covers treasury pending-settlements endpoint", async () => {
    const res = await request(app).get("/api-docs/swagger.json")
    const spec = res.body

    expect(spec.paths).toHaveProperty("/api/treasury/pending-settlements")
    expect(spec.paths["/api/treasury/pending-settlements"]).toHaveProperty("get")
  })

  it("spec includes reusable ErrorResponse schema component", async () => {
    const res = await request(app).get("/api-docs/swagger.json")
    const spec = res.body

    expect(spec.components?.schemas).toHaveProperty("ErrorResponse")
    expect(spec.components.schemas.ErrorResponse.properties).toHaveProperty("error")
  })
})
