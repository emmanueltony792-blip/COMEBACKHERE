import { renderHook, act } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import * as soroban from "../utils/soroban"
import { useInvoice } from "../hooks/useInvoice"

vi.mock("../utils/soroban", () => ({
  fetchInvoice: vi.fn(),
  payInvoice: vi.fn(),
  cancelInvoice: vi.fn(),
  requestRefund: vi.fn(),
  releaseEscrow: vi.fn(),
}))

const mockInvoice = {
  id: "42",
  merchant: "GABCDEF123",
  payer: "GZYXWV456",
  amount_usdc: "1000000",
  gross_usdc: "1050000",
  expires_at: 2000000000,
  status: "Pending",
  paid_at: null,
  metadata_hash: null,
  payment_link_hash: null,
}

function mockPaymentResult(overrides = {}) {
  return { success: true, transaction_hash: "txhash123", ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("useInvoice", () => {
  it("starts with null invoice, loading=false, error=null", () => {
    const { result } = renderHook(() => useInvoice())
    expect(result.current.invoice).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it("loadInvoice sets loading=true and updates invoice on success", async () => {
    vi.mocked(soroban.fetchInvoice).mockResolvedValue(mockInvoice as any)

    const { result } = renderHook(() => useInvoice())

    await act(async () => {
      await result.current.loadInvoice(42)
    })

    expect(result.current.loading).toBe(false)
    expect(result.current.invoice).toEqual(mockInvoice)
    expect(result.current.error).toBeNull()
  })

  it("loadInvoice sets error on failure", async () => {
    vi.mocked(soroban.fetchInvoice).mockRejectedValue(
      new Error("Invoice not found"),
    )

    const { result } = renderHook(() => useInvoice())

    await act(async () => {
      await result.current.loadInvoice(999)
    })

    expect(result.current.loading).toBe(false)
    expect(result.current.invoice).toBeNull()
    expect(result.current.error).toBe("Invoice not found")
  })

  it("loadInvoice sets generic error for non-Error throws", async () => {
    vi.mocked(soroban.fetchInvoice).mockRejectedValue("string error")

    const { result } = renderHook(() => useInvoice())

    await act(async () => {
      await result.current.loadInvoice(1)
    })

    expect(result.current.error).toBe("Failed to load invoice")
  })

  it("pay calls payInvoice and returns success", async () => {
    vi.mocked(soroban.fetchInvoice).mockResolvedValue(mockInvoice as any)
    vi.mocked(soroban.payInvoice).mockResolvedValue(mockPaymentResult())

    const { result } = renderHook(() => useInvoice())

    await act(async () => {
      await result.current.loadInvoice(42)
    })

    let paymentResult: any
    await act(async () => {
      paymentResult = await result.current.pay("GPUBKEY")
    })

    expect(vi.mocked(soroban.payInvoice)).toHaveBeenCalledWith(
      expect.any(String),
      42,
      "GPUBKEY",
    )
    expect(paymentResult.success).toBe(true)
    expect(paymentResult.transaction_hash).toBe("txhash123")
  })

  it("pay reloads invoice on success", async () => {
    vi.mocked(soroban.fetchInvoice).mockResolvedValue(mockInvoice as any)
    vi.mocked(soroban.payInvoice).mockResolvedValue(mockPaymentResult())

    const { result } = renderHook(() => useInvoice())

    await act(async () => {
      await result.current.loadInvoice(42)
    })

    vi.mocked(soroban.fetchInvoice).mockClear()

    await act(async () => {
      await result.current.pay("GPUBKEY")
    })

    expect(vi.mocked(soroban.fetchInvoice)).toHaveBeenCalledWith(
      expect.any(String),
      42,
    )
  })

  it("pay returns error when no invoice loaded", async () => {
    const { result } = renderHook(() => useInvoice())

    let paymentResult: any
    await act(async () => {
      paymentResult = await result.current.pay("GPUBKEY")
    })

    expect(paymentResult.success).toBe(false)
    expect(paymentResult.error).toBe("No invoice loaded")
  })

  it("cancel calls cancelInvoice and returns success", async () => {
    vi.mocked(soroban.fetchInvoice).mockResolvedValue(mockInvoice as any)
    vi.mocked(soroban.cancelInvoice).mockResolvedValue(mockPaymentResult())

    const { result } = renderHook(() => useInvoice())

    await act(async () => {
      await result.current.loadInvoice(42)
    })

    let paymentResult: any
    await act(async () => {
      paymentResult = await result.current.cancel("GPUBKEY")
    })

    expect(vi.mocked(soroban.cancelInvoice)).toHaveBeenCalledWith(
      expect.any(String),
      42,
      "GPUBKEY",
    )
    expect(paymentResult.success).toBe(true)
  })

  it("cancel reloads invoice on success", async () => {
    vi.mocked(soroban.fetchInvoice).mockResolvedValue(mockInvoice as any)
    vi.mocked(soroban.cancelInvoice).mockResolvedValue(mockPaymentResult())

    const { result } = renderHook(() => useInvoice())

    await act(async () => {
      await result.current.loadInvoice(42)
    })

    vi.mocked(soroban.fetchInvoice).mockClear()

    await act(async () => {
      await result.current.cancel("GPUBKEY")
    })

    expect(vi.mocked(soroban.fetchInvoice)).toHaveBeenCalledWith(
      expect.any(String),
      42,
    )
  })

  it("cancel returns error when no invoice loaded", async () => {
    const { result } = renderHook(() => useInvoice())

    let paymentResult: any
    await act(async () => {
      paymentResult = await result.current.cancel("GPUBKEY")
    })

    expect(paymentResult.success).toBe(false)
    expect(paymentResult.error).toBe("No invoice loaded")
  })

  it("refund calls requestRefund and returns success", async () => {
    vi.mocked(soroban.fetchInvoice).mockResolvedValue(mockInvoice as any)
    vi.mocked(soroban.requestRefund).mockResolvedValue(mockPaymentResult())

    const { result } = renderHook(() => useInvoice())

    await act(async () => {
      await result.current.loadInvoice(42)
    })

    let paymentResult: any
    await act(async () => {
      paymentResult = await result.current.refund("GPUBKEY")
    })

    expect(vi.mocked(soroban.requestRefund)).toHaveBeenCalledWith(
      expect.any(String),
      42,
      "GPUBKEY",
    )
    expect(paymentResult.success).toBe(true)
  })

  it("refund reloads invoice on success", async () => {
    vi.mocked(soroban.fetchInvoice).mockResolvedValue(mockInvoice as any)
    vi.mocked(soroban.requestRefund).mockResolvedValue(mockPaymentResult())

    const { result } = renderHook(() => useInvoice())

    await act(async () => {
      await result.current.loadInvoice(42)
    })

    vi.mocked(soroban.fetchInvoice).mockClear()

    await act(async () => {
      await result.current.refund("GPUBKEY")
    })

    expect(vi.mocked(soroban.fetchInvoice)).toHaveBeenCalledWith(
      expect.any(String),
      42,
    )
  })

  it("refund returns error when no invoice loaded", async () => {
    const { result } = renderHook(() => useInvoice())

    let paymentResult: any
    await act(async () => {
      paymentResult = await result.current.refund("GPUBKEY")
    })

    expect(paymentResult.success).toBe(false)
    expect(paymentResult.error).toBe("No invoice loaded")
  })

  it("release calls releaseEscrow and returns success", async () => {
    vi.mocked(soroban.fetchInvoice).mockResolvedValue(mockInvoice as any)
    vi.mocked(soroban.releaseEscrow).mockResolvedValue(mockPaymentResult())

    const { result } = renderHook(() => useInvoice())

    await act(async () => {
      await result.current.loadInvoice(42)
    })

    let paymentResult: any
    await act(async () => {
      paymentResult = await result.current.release("GPUBKEY")
    })

    expect(vi.mocked(soroban.releaseEscrow)).toHaveBeenCalledWith(
      expect.any(String),
      42,
      "GPUBKEY",
    )
    expect(paymentResult.success).toBe(true)
  })

  it("release reloads invoice on success", async () => {
    vi.mocked(soroban.fetchInvoice).mockResolvedValue(mockInvoice as any)
    vi.mocked(soroban.releaseEscrow).mockResolvedValue(mockPaymentResult())

    const { result } = renderHook(() => useInvoice())

    await act(async () => {
      await result.current.loadInvoice(42)
    })

    vi.mocked(soroban.fetchInvoice).mockClear()

    await act(async () => {
      await result.current.release("GPUBKEY")
    })

    expect(vi.mocked(soroban.fetchInvoice)).toHaveBeenCalledWith(
      expect.any(String),
      42,
    )
  })

  it("release returns error when no invoice loaded", async () => {
    const { result } = renderHook(() => useInvoice())

    let paymentResult: any
    await act(async () => {
      paymentResult = await result.current.release("GPUBKEY")
    })

    expect(paymentResult.success).toBe(false)
    expect(paymentResult.error).toBe("No invoice loaded")
  })

  it("loadInvoice sets loading during fetch", async () => {
    let resolveFetch: (v: any) => void
    const fetchPromise = new Promise<any>((resolve) => {
      resolveFetch = resolve
    })
    vi.mocked(soroban.fetchInvoice).mockReturnValue(fetchPromise)

    const { result } = renderHook(() => useInvoice())

    let loadPromise: Promise<void>
    act(() => {
      loadPromise = result.current.loadInvoice(42)
    })

    expect(result.current.loading).toBe(true)

    await act(async () => {
      resolveFetch!(mockInvoice)
      await loadPromise!
    })

    expect(result.current.loading).toBe(false)
    expect(result.current.invoice).toEqual(mockInvoice)
  })
})
