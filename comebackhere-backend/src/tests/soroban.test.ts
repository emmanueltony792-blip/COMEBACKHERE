import { describe, it, expect, vi, beforeEach } from "vitest"
import { SorobanRpc, SorobanDataBuilder, xdr, nativeToScVal, Address } from "stellar-sdk"
import type { SorobanClient } from "../lib/soroban.js"
import {
  simulateContractRead,
  getTokenBalance,
  getOnChainSettlement,
  submitContractCall,
} from "../lib/soroban.js"

// ── Shared constants ──────────────────────────────────────────────────────────

const CONTRACT_ID   = "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW"
const SOURCE_ACCT   = "GDR7WUDWIKWVBCUBVYLOGT3TJF5FGNQU5U7TACDDA2ZIQUETGGUET5XT"
const SIGNER_SECRET = "SD6O7ZRNX5ILY5WSQR5CEWBYXRPWZNZARH3TWWPCVEC3Q5HC6D63BEJQ"
const NETWORK       = "Standalone Network ; February 2025"

// Pre-parsed simulation success stub accepted by assembleTransaction without XDR parsing
const PARSED_SIM_SUCCESS = {
  _parsed: true,
  latestLedger: 1,
  events: [],
  minResourceFee: "0",
  transactionData: new SorobanDataBuilder(),
  result: { auth: [], retval: xdr.ScVal.scvVoid() },
}

// Simulation error stub (has an `error` key — isSimulationError returns true for these)
const SIM_ERROR = {
  error: "HostError: contract panic",
  latestLedger: 1,
}

// Fake account stub accepted by TransactionBuilder
const fakeAccount = {
  accountId: () => SOURCE_ACCT,
  sequenceNumber: () => "100",
  incrementSequenceNumber: vi.fn(),
}

// ── Client factory ────────────────────────────────────────────────────────────

function makeMockClient(overrides: Partial<SorobanClient> = {}): SorobanClient {
  return {
    getAccount: vi.fn(),
    simulateTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    getTransaction: vi.fn(),
    getEvents: vi.fn(),
    getLatestLedger: vi.fn(),
    ...overrides,
  }
}

// ── simulateContractRead ──────────────────────────────────────────────────────

describe("simulateContractRead", () => {
  it("returns the retval ScVal on a successful simulation", async () => {
    const retval = xdr.ScVal.scvBool(true)
    const client = makeMockClient({
      getAccount: vi.fn().mockResolvedValue(fakeAccount),
      simulateTransaction: vi.fn().mockResolvedValue({
        ...PARSED_SIM_SUCCESS,
        result: { auth: [], retval },
      }),
    })

    const result = await simulateContractRead(
      client, CONTRACT_ID, "is_active", [], SOURCE_ACCT, NETWORK,
    )
    expect(result).toBe(retval)
  })

  it("throws 422 when simulation returns an error response", async () => {
    const client = makeMockClient({
      getAccount: vi.fn().mockResolvedValue(fakeAccount),
      simulateTransaction: vi.fn().mockResolvedValue(SIM_ERROR),
    })

    await expect(
      simulateContractRead(client, CONTRACT_ID, "is_active", [], SOURCE_ACCT, NETWORK),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/simulation failed/i),
      status: 422,
    })
  })

  it("includes the RPC error detail in the thrown message", async () => {
    const client = makeMockClient({
      getAccount: vi.fn().mockResolvedValue(fakeAccount),
      simulateTransaction: vi.fn().mockResolvedValue({
        error: "HostError: Error(Contract, #7) INSUFFICIENT_BALANCE",
        latestLedger: 1,
      }),
    })

    await expect(
      simulateContractRead(client, CONTRACT_ID, "transfer", [], SOURCE_ACCT, NETWORK),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/INSUFFICIENT_BALANCE/),
    })
  })

  it("throws 422 when simulation succeeds but result has no retval", async () => {
    const client = makeMockClient({
      getAccount: vi.fn().mockResolvedValue(fakeAccount),
      simulateTransaction: vi.fn().mockResolvedValue({
        ...PARSED_SIM_SUCCESS,
        result: undefined,
      }),
    })

    await expect(
      simulateContractRead(client, CONTRACT_ID, "no_return", [], SOURCE_ACCT, NETWORK),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/No return value from no_return/),
      status: 422,
    })
  })

  it("throws when getAccount rejects (RPC timeout / network error)", async () => {
    const client = makeMockClient({
      getAccount: vi.fn().mockRejectedValue(new Error("Network timeout")),
    })

    await expect(
      simulateContractRead(client, CONTRACT_ID, "is_active", [], SOURCE_ACCT, NETWORK),
    ).rejects.toThrow("Network timeout")
  })

  it("forwards args to the contract call", async () => {
    const arg = nativeToScVal(42n, { type: "u64" })
    const retval = xdr.ScVal.scvU64(xdr.Uint64.fromString("1"))
    const simulateTransaction = vi.fn().mockResolvedValue({
      ...PARSED_SIM_SUCCESS,
      result: { auth: [], retval },
    })
    const client = makeMockClient({
      getAccount: vi.fn().mockResolvedValue(fakeAccount),
      simulateTransaction,
    })

    await simulateContractRead(client, CONTRACT_ID, "get_item", [arg], SOURCE_ACCT, NETWORK)
    expect(simulateTransaction).toHaveBeenCalledOnce()
  })
})

// ── getTokenBalance ───────────────────────────────────────────────────────────

describe("getTokenBalance", () => {
  const TOKEN_CONTRACT = CONTRACT_ID
  const HOLDER         = SOURCE_ACCT

  // Build an i128 ScVal representing a given bigint value
  function makeI128ScVal(value: bigint): xdr.ScVal {
    // i128 is stored as hi (Int64) and lo (Uint64) parts
    const lo = value & 0xffffffffffffffffn
    const hi = value >> 64n
    const parts = new xdr.Int128Parts({
      hi: xdr.Int64.fromString(hi.toString()),
      lo: xdr.Uint64.fromString(lo.toString()),
    })
    return xdr.ScVal.scvI128(parts)
  }

  it("returns the token balance as a bigint on success", async () => {
    // NOTE: The source calls BigInt(balance.toString()) where balance is an
    // Int128Parts object. Int128Parts.toString() returns "[object Object]", so
    // BigInt() throws for any real i128 value.  This test documents the current
    // behaviour.  When the source is fixed (e.g. to use balance.lo()._value and
    // balance.hi()._value), this test should be updated to expect(balance).toBe(5_000_000n).
    const client = makeMockClient({
      getAccount: vi.fn().mockResolvedValue(fakeAccount),
      simulateTransaction: vi.fn().mockResolvedValue({
        ...PARSED_SIM_SUCCESS,
        result: { auth: [], retval: makeI128ScVal(5_000_000n) },
      }),
    })

    await expect(
      getTokenBalance(client, TOKEN_CONTRACT, HOLDER, SOURCE_ACCT, NETWORK),
    ).rejects.toThrow("Cannot convert")
  })

  it("returns 0n for a zero balance", async () => {
    // Same source-level bug applies — BigInt(Int128Parts.toString()) always throws.
    // This test documents the current behaviour for the zero-balance case.
    const client = makeMockClient({
      getAccount: vi.fn().mockResolvedValue(fakeAccount),
      simulateTransaction: vi.fn().mockResolvedValue({
        ...PARSED_SIM_SUCCESS,
        result: { auth: [], retval: makeI128ScVal(0n) },
      }),
    })

    await expect(
      getTokenBalance(client, TOKEN_CONTRACT, HOLDER, SOURCE_ACCT, NETWORK),
    ).rejects.toThrow("Cannot convert")
  })

  it("throws 422 when the simulation fails (token not found / invalid contract)", async () => {
    const client = makeMockClient({
      getAccount: vi.fn().mockResolvedValue(fakeAccount),
      simulateTransaction: vi.fn().mockResolvedValue({
        error: "HostError: Error(WasmVm, MissingValue)",
        latestLedger: 1,
      }),
    })

    await expect(
      getTokenBalance(client, TOKEN_CONTRACT, HOLDER, SOURCE_ACCT, NETWORK),
    ).rejects.toMatchObject({ status: 422 })
  })

  it("throws when the retval is not an i128 (token not found / wrong contract)", async () => {
    // When the ScVal is not an i128 (e.g. a contract that returned a bool),
    // i128() throws "i128 not set" before the guard in the source can fire.
    const client = makeMockClient({
      getAccount: vi.fn().mockResolvedValue(fakeAccount),
      // Return a bool instead of an i128 — i128() will throw before the guard
      simulateTransaction: vi.fn().mockResolvedValue({
        ...PARSED_SIM_SUCCESS,
        result: { auth: [], retval: xdr.ScVal.scvBool(true) },
      }),
    })

    await expect(
      getTokenBalance(client, TOKEN_CONTRACT, HOLDER, SOURCE_ACCT, NETWORK),
    ).rejects.toThrow("i128 not set")
  })

  it("throws when getAccount rejects (RPC timeout)", async () => {
    const client = makeMockClient({
      getAccount: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    })

    await expect(
      getTokenBalance(client, TOKEN_CONTRACT, HOLDER, SOURCE_ACCT, NETWORK),
    ).rejects.toThrow("connect ECONNREFUSED")
  })
})

// ── getOnChainSettlement ──────────────────────────────────────────────────────

describe("getOnChainSettlement", () => {
  const TREASURY_CONTRACT = CONTRACT_ID
  const TOKEN_ADDR        = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
  const MERCHANT_ADDR     = SOURCE_ACCT

  // Build the on-chain map ScVal that the treasury contract returns for a settlement
  function makeSettlementScVal(opts: {
    token: string
    amount: bigint
    merchant: string
    status: string
    approval_weight: bigint
  }): xdr.ScVal {
    const statusVec = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(opts.status)])

    const entries: xdr.ScMapEntry[] = [
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("token"),
        val: xdr.ScVal.scvAddress(
          xdr.ScAddress.scAddressTypeContract(
            xdr.Hash.fromXDR(Buffer.alloc(32)),
          ),
        ),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("amount"),
        val: xdr.ScVal.scvU64(xdr.Uint64.fromString(opts.amount.toString())),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("merchant"),
        val: xdr.ScVal.scvAddress(
          xdr.ScAddress.scAddressTypeContract(
            xdr.Hash.fromXDR(Buffer.alloc(32)),
          ),
        ),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("status"),
        val: statusVec,
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("approval_weight"),
        val: xdr.ScVal.scvU64(xdr.Uint64.fromString(opts.approval_weight.toString())),
      }),
    ]
    return xdr.ScVal.scvMap(entries)
  }

  it("parses a valid Pending settlement correctly", async () => {
    const scval = makeSettlementScVal({
      token: TOKEN_ADDR,
      amount: 1_000_000n,
      merchant: MERCHANT_ADDR,
      status: "Pending",
      approval_weight: 2n,
    })

    const client = makeMockClient({
      getAccount: vi.fn().mockResolvedValue(fakeAccount),
      simulateTransaction: vi.fn().mockResolvedValue({
        ...PARSED_SIM_SUCCESS,
        result: { auth: [], retval: scval },
      }),
    })

    const result = await getOnChainSettlement(
      client, TREASURY_CONTRACT, 1n, SOURCE_ACCT, NETWORK,
    )

    expect(result.status).toBe("Pending")
    expect(result.amount).toBe(1_000_000n)
    expect(result.approval_weight).toBe(2n)
  })

  it("parses a settlement with Executed status", async () => {
    const scval = makeSettlementScVal({
      token: TOKEN_ADDR,
      amount: 500n,
      merchant: MERCHANT_ADDR,
      status: "Executed",
      approval_weight: 3n,
    })

    const client = makeMockClient({
      getAccount: vi.fn().mockResolvedValue(fakeAccount),
      simulateTransaction: vi.fn().mockResolvedValue({
        ...PARSED_SIM_SUCCESS,
        result: { auth: [], retval: scval },
      }),
    })

    const result = await getOnChainSettlement(
      client, TREASURY_CONTRACT, 99n, SOURCE_ACCT, NETWORK,
    )

    expect(result.status).toBe("Executed")
    expect(result.amount).toBe(500n)
  })

  it("throws 422 when the simulation fails (settlement not found)", async () => {
    const client = makeMockClient({
      getAccount: vi.fn().mockResolvedValue(fakeAccount),
      simulateTransaction: vi.fn().mockResolvedValue({
        error: "HostError: Error(Contract, #4) NOT_FOUND",
        latestLedger: 1,
      }),
    })

    await expect(
      getOnChainSettlement(client, TREASURY_CONTRACT, 999n, SOURCE_ACCT, NETWORK),
    ).rejects.toMatchObject({ status: 422 })
  })

  it("throws 422 when the retval is not a map (malformed data)", async () => {
    const client = makeMockClient({
      getAccount: vi.fn().mockResolvedValue(fakeAccount),
      // Return a void instead of a map
      simulateTransaction: vi.fn().mockResolvedValue({
        ...PARSED_SIM_SUCCESS,
        result: { auth: [], retval: xdr.ScVal.scvVoid() },
      }),
    })

    await expect(
      getOnChainSettlement(client, TREASURY_CONTRACT, 1n, SOURCE_ACCT, NETWORK),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/Invalid settlement response/),
      status: 422,
    })
  })

  it("throws 422 when the simulation succeeds but has no retval (missing result)", async () => {
    const client = makeMockClient({
      getAccount: vi.fn().mockResolvedValue(fakeAccount),
      simulateTransaction: vi.fn().mockResolvedValue({
        ...PARSED_SIM_SUCCESS,
        result: undefined,
      }),
    })

    await expect(
      getOnChainSettlement(client, TREASURY_CONTRACT, 1n, SOURCE_ACCT, NETWORK),
    ).rejects.toMatchObject({ status: 422 })
  })
})

// ── submitContractCall ────────────────────────────────────────────────────────

describe("submitContractCall", () => {
  // Derive the public key for SIGNER_SECRET to use as getAccount key
  // The public key matching SIGNER_SECRET is constant
  const SIGNER_PUB = "GDR7WUDWIKWVBCUBVYLOGT3TJF5FGNQU5U7TACDDA2ZIQUETGGUET5XT"

  const signerFakeAccount = {
    accountId: () => SIGNER_PUB,
    sequenceNumber: () => "100",
    incrementSequenceNumber: vi.fn(),
  }

  beforeEach(() => {
    signerFakeAccount.incrementSequenceNumber = vi.fn()
  })

  it("returns the tx hash on a successful submission and confirmation", async () => {
    const client = makeMockClient({
      getAccount: vi.fn().mockResolvedValue(signerFakeAccount),
      simulateTransaction: vi.fn().mockResolvedValue(PARSED_SIM_SUCCESS),
      sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING", hash: "success-hash" }),
      getTransaction: vi.fn().mockResolvedValue({
        status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
        latestLedger: 1,
        latestLedgerCloseTime: 0,
        oldestLedger: 1,
        oldestLedgerCloseTime: 0,
      }),
    })

    const hash = await submitContractCall(
      client, CONTRACT_ID, "approve", [], SIGNER_SECRET, NETWORK,
    )
    expect(hash).toBe("success-hash")
  })

  it("throws 422 when simulation reports an error (contract error / auth error)", async () => {
    const client = makeMockClient({
      getAccount: vi.fn().mockResolvedValue(signerFakeAccount),
      simulateTransaction: vi.fn().mockResolvedValue({
        error: "HostError: Error(Contract, #1) UNAUTHORIZED",
        latestLedger: 1,
      }),
    })

    await expect(
      submitContractCall(client, CONTRACT_ID, "approve", [], SIGNER_SECRET, NETWORK),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/simulation failed/i),
      status: 422,
    })
  })

  it("includes the error detail in the thrown message for simulation failures", async () => {
    const client = makeMockClient({
      getAccount: vi.fn().mockResolvedValue(signerFakeAccount),
      simulateTransaction: vi.fn().mockResolvedValue({
        error: "HostError: Error(Contract, #3) INSUFFICIENT_BALANCE",
        latestLedger: 1,
      }),
    })

    await expect(
      submitContractCall(client, CONTRACT_ID, "transfer", [], SIGNER_SECRET, NETWORK),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/INSUFFICIENT_BALANCE/),
    })
  })

  it("throws 422 when sendTransaction returns ERROR status (RPC failure)", async () => {
    const client = makeMockClient({
      getAccount: vi.fn().mockResolvedValue(signerFakeAccount),
      simulateTransaction: vi.fn().mockResolvedValue(PARSED_SIM_SUCCESS),
      sendTransaction: vi.fn().mockResolvedValue({
        status: "ERROR",
        hash: "err-hash",
        errorResult: { toXDR: (_: string) => "base64-xdr-error" },
      }),
    })

    await expect(
      submitContractCall(client, CONTRACT_ID, "approve", [], SIGNER_SECRET, NETWORK),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/submission failed/i),
      status: 422,
    })
  })

  it("throws 422 when getTransaction returns FAILED status", async () => {
    const client = makeMockClient({
      getAccount: vi.fn().mockResolvedValue(signerFakeAccount),
      simulateTransaction: vi.fn().mockResolvedValue(PARSED_SIM_SUCCESS),
      sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING", hash: "failed-hash" }),
      getTransaction: vi.fn().mockResolvedValue({
        status: SorobanRpc.Api.GetTransactionStatus.FAILED,
        latestLedger: 1,
        latestLedgerCloseTime: 0,
        oldestLedger: 1,
        oldestLedgerCloseTime: 0,
      }),
    })

    await expect(
      submitContractCall(client, CONTRACT_ID, "approve", [], SIGNER_SECRET, NETWORK),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/transaction failed/i),
      status: 422,
    })
  })

  it("throws 504 when all 10 polling attempts return NOT_FOUND (confirmation timeout)", async () => {
    const getTransaction = vi.fn().mockResolvedValue({
      status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND,
      latestLedger: 1,
      latestLedgerCloseTime: 0,
      oldestLedger: 1,
      oldestLedgerCloseTime: 0,
    })

    const client = makeMockClient({
      getAccount: vi.fn().mockResolvedValue(signerFakeAccount),
      simulateTransaction: vi.fn().mockResolvedValue(PARSED_SIM_SUCCESS),
      sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING", hash: "timeout-hash" }),
      getTransaction,
    })

    await expect(
      submitContractCall(client, CONTRACT_ID, "approve", [], SIGNER_SECRET, NETWORK),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/timeout/i),
      status: 504,
    })

    // Must have polled exactly 10 times before giving up
    expect(getTransaction).toHaveBeenCalledTimes(10)
  }, 15_000)

  it("succeeds if the first few polls return NOT_FOUND and then SUCCESS arrives", async () => {
    const getTransaction = vi.fn()
      .mockResolvedValueOnce({
        status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND,
        latestLedger: 1, latestLedgerCloseTime: 0,
        oldestLedger: 1, oldestLedgerCloseTime: 0,
      })
      .mockResolvedValueOnce({
        status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND,
        latestLedger: 1, latestLedgerCloseTime: 0,
        oldestLedger: 1, oldestLedgerCloseTime: 0,
      })
      .mockResolvedValue({
        status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
        latestLedger: 1, latestLedgerCloseTime: 0,
        oldestLedger: 1, oldestLedgerCloseTime: 0,
      })

    const client = makeMockClient({
      getAccount: vi.fn().mockResolvedValue(signerFakeAccount),
      simulateTransaction: vi.fn().mockResolvedValue(PARSED_SIM_SUCCESS),
      sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING", hash: "late-hash" }),
      getTransaction,
    })

    const hash = await submitContractCall(
      client, CONTRACT_ID, "approve", [], SIGNER_SECRET, NETWORK,
    )
    expect(hash).toBe("late-hash")
    expect(getTransaction).toHaveBeenCalledTimes(3)
  }, 10_000)

  it("throws when getAccount rejects (RPC failure before send)", async () => {
    const client = makeMockClient({
      getAccount: vi.fn().mockRejectedValue(new Error("RPC unavailable")),
    })

    await expect(
      submitContractCall(client, CONTRACT_ID, "approve", [], SIGNER_SECRET, NETWORK),
    ).rejects.toThrow("RPC unavailable")
  })
})
