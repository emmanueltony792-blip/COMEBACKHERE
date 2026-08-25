import { describe, it, expect } from "vitest"
import { validateEnv } from "../index.js"

const FULL_ENV: Record<string, string> = {
  MONGODB_URI: "mongodb://localhost:27017",
  REDIS_URL: "redis://localhost:6379",
  SOROBAN_RPC_URL: "http://localhost:8000",
  TREASURY_CONTRACT_ID: "CTREASURY",
  INVOICE_CONTRACT_ID: "CINVOICE",
  ADMIN_KEY: "secret-admin",
  WEBHOOK_SECRET: "secret-webhook",
}

describe("validateEnv", () => {
  it("does not throw when all required vars are present", () => {
    expect(() => validateEnv(FULL_ENV)).not.toThrow()
  })

  it("throws when a single required var is missing", () => {
    const env = { ...FULL_ENV }
    delete env.MONGODB_URI

    expect(() => validateEnv(env)).toThrow(/MONGODB_URI/)
  })

  it("lists every missing var in one error, not just the first one found", () => {
    const env = { ...FULL_ENV }
    delete env.REDIS_URL
    delete env.WEBHOOK_SECRET

    let err: Error | null = null
    try {
      validateEnv(env)
    } catch (e) {
      err = e as Error
    }

    expect(err).not.toBeNull()
    expect(err!.message).toMatch(/REDIS_URL/)
    expect(err!.message).toMatch(/WEBHOOK_SECRET/)
  })

  it("includes all seven required vars in the error when none are set", () => {
    let err: Error | null = null
    try {
      validateEnv({})
    } catch (e) {
      err = e as Error
    }

    expect(err).not.toBeNull()
    const message = err!.message
    expect(message).toMatch(/MONGODB_URI/)
    expect(message).toMatch(/REDIS_URL/)
    expect(message).toMatch(/SOROBAN_RPC_URL/)
    expect(message).toMatch(/TREASURY_CONTRACT_ID/)
    expect(message).toMatch(/INVOICE_CONTRACT_ID/)
    expect(message).toMatch(/ADMIN_KEY/)
    expect(message).toMatch(/WEBHOOK_SECRET/)
  })

  it("throws with a human-readable hint to set the missing variables", () => {
    expect(() => validateEnv({})).toThrow(/Set the above variables/)
  })
})
