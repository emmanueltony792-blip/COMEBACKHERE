import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { InvoicePayment } from "../components/InvoicePayment"

const mockInvoice = {
  id: "42",
  merchant: "GDR7WUDWIKWVBCUBVYLOGT3TJF5FGNQU5U7TACDDA2ZIQUETGGUET5XT",
  payer: "GBDXOEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  amount_usdc: "1000",
  gross_usdc: "1050",
  expires_at: Math.floor(Date.now() / 1000) + 86400,
  status: "Pending" as const,
  paid_at: null,
  metadata_hash: null,
  payment_link_hash: null,
}

let mockUseInvoice: any
let mockUseWallet: any

vi.mock("../hooks/useInvoice", () => ({
  useInvoice: () => mockUseInvoice,
}))

vi.mock("../hooks/useWallet", () => ({
  useWallet: () => mockUseWallet,
}))

vi.mock("../components/InvoiceQRCode", () => ({
  InvoiceQRCode: () => <div data-testid="mock-qr-code" />,
}))

vi.mock("../components/TransactionHistory", () => ({
  TransactionHistory: () => <div data-testid="mock-transaction-history" />,
}))

vi.mock("../components/PayConfirmationModal", () => ({
  PayConfirmationModal: ({ onConfirm, onCancel, submitting }: any) => (
    <div data-testid="pay-confirmation-modal">
      <button onClick={onConfirm} disabled={submitting} data-testid="confirm-pay-btn">
        {submitting ? "Processing..." : "Confirm Pay"}
      </button>
      <button onClick={onCancel} data-testid="cancel-pay-btn">Cancel</button>
    </div>
  ),
}))

vi.mock("../components/CancelConfirmationModal", () => ({
  CancelConfirmationModal: ({ onConfirm, onCancel, submitting }: any) => (
    <div data-testid="cancel-confirmation-modal">
      <button onClick={onConfirm} disabled={submitting} data-testid="confirm-cancel-btn">
        {submitting ? "Processing..." : "Confirm Cancel"}
      </button>
      <button onClick={onCancel} data-testid="cancel-cancel-btn">Cancel</button>
    </div>
  ),
}))

beforeEach(() => {
  mockUseInvoice = {
    invoice: null,
    loading: false,
    error: null,
    loadInvoice: vi.fn(),
    pay: vi.fn(),
    cancel: vi.fn(),
  }
  mockUseWallet = {
    address: null,
    connected: false,
    connecting: false,
    connect: vi.fn(),
  }
})

describe("InvoicePayment", () => {
  it("renders invoice lookup form", () => {
    render(<InvoicePayment />)
    expect(screen.getByLabelText("Invoice ID for payment")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /load invoice/i })).toBeInTheDocument()
  })

  it("loads invoice from URL query param on mount", () => {
    const loadInvoice = vi.fn()
    mockUseInvoice.loadInvoice = loadInvoice

    const originalSearch = window.location.search
    Object.defineProperty(window, "location", {
      value: { search: "?invoiceId=99" },
      writable: true,
    })

    render(<InvoicePayment />)
    expect(loadInvoice).toHaveBeenCalledWith(99)

    Object.defineProperty(window, "location", {
      value: { search: originalSearch },
      writable: true,
    })
  })

  it("shows loading state", () => {
    mockUseInvoice.loading = true
    render(<InvoicePayment />)
    expect(screen.getByText("Loading...")).toBeInTheDocument()
    expect(screen.getByLabelText("Loading invoice")).toBeDisabled()
  })

  it("shows error state", () => {
    mockUseInvoice.error = "Invoice not found"
    render(<InvoicePayment />)
    expect(screen.getByRole("alert")).toHaveTextContent("Invoice not found")
  })

  it("calls loadInvoice when search button is clicked", async () => {
    const loadInvoice = vi.fn()
    mockUseInvoice.loadInvoice = loadInvoice
    const user = userEvent.setup()

    render(<InvoicePayment />)
    const input = screen.getByLabelText("Invoice ID for payment")
    await user.type(input, "42")
    await user.click(screen.getByRole("button", { name: /load invoice/i }))

    expect(loadInvoice).toHaveBeenCalledWith(42)
  })

  it("disables load button while loading", () => {
    mockUseInvoice.loading = true
    render(<InvoicePayment />)
    expect(screen.getByRole("button", { name: /loading invoice/i })).toBeDisabled()
  })

  it("disables load button when input is empty", () => {
    render(<InvoicePayment />)
    expect(screen.getByRole("button", { name: /load invoice/i })).toBeDisabled()
  })
})

describe("InvoicePayment — invoice loaded", () => {
  it("displays invoice details", () => {
    mockUseInvoice.invoice = mockInvoice
    render(<InvoicePayment />)
    expect(screen.getAllByText("42").length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText("1000")).toBeInTheDocument()
    expect(screen.getByText("1050")).toBeInTheDocument()
  })

  it("shows countdown timer when invoice has expires_at", () => {
    mockUseInvoice.invoice = mockInvoice
    render(<InvoicePayment />)
    const countdownEl = screen.getByText(/^\d+d \d+h \d+m \d+s$/)
    expect(countdownEl).toBeInTheDocument()
  })

  it("shows expired badge when countdown is zero", () => {
    const expiredInvoice = {
      ...mockInvoice,
      expires_at: Math.floor(Date.now() / 1000) - 1,
      status: "Expired" as const,
    }
    mockUseInvoice.invoice = expiredInvoice
    render(<InvoicePayment />)
    const expiredElements = screen.getAllByText("Expired")
    expect(expiredElements.length).toBeGreaterThanOrEqual(1)
  })

  it("renders QR code and transaction history for loaded invoice", () => {
    mockUseInvoice.invoice = mockInvoice
    render(<InvoicePayment />)
    expect(screen.getByTestId("mock-qr-code")).toBeInTheDocument()
    expect(screen.getByTestId("mock-transaction-history")).toBeInTheDocument()
  })
})

describe("InvoicePayment — pay button", () => {
  it("shows connect wallet button when not connected", () => {
    mockUseInvoice.invoice = mockInvoice
    render(<InvoicePayment />)
    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeInTheDocument()
  })

  it("calls connect when connect wallet button is clicked", async () => {
    const connect = vi.fn()
    mockUseWallet.connect = connect
    mockUseInvoice.invoice = mockInvoice
    const user = userEvent.setup()

    render(<InvoicePayment />)
    await user.click(screen.getByRole("button", { name: /connect wallet/i }))
    expect(connect).toHaveBeenCalledOnce()
  })

  it("shows pay button when connected and invoice is pending", () => {
    mockUseWallet.connected = true
    mockUseWallet.address = "GDR7WUDWIKWVBCUBVYLOGT3TJF5FGNQU5U7TACDDA2ZIQUETGGUET5XT"
    mockUseInvoice.invoice = mockInvoice
    render(<InvoicePayment />)
    expect(screen.getByRole("button", { name: /pay invoice #42/i })).toBeInTheDocument()
  })

  it("pay button is not shown when invoice is not pending", () => {
    mockUseWallet.connected = true
    mockUseInvoice.invoice = { ...mockInvoice, status: "Paid" }
    render(<InvoicePayment />)
    expect(screen.queryByRole("button", { name: /pay invoice/i })).not.toBeInTheDocument()
  })

  it("shows status text when invoice is not pending and connected", () => {
    mockUseWallet.connected = true
    mockUseInvoice.invoice = { ...mockInvoice, status: "Paid" }
    render(<InvoicePayment />)
    expect(screen.getByText(/not available for payment/)).toBeInTheDocument()
  })
})

describe("InvoicePayment — cancel flow", () => {
  it("shows cancel button when connected as merchant and invoice is pending", () => {
    mockUseWallet.connected = true
    mockUseWallet.address = mockInvoice.merchant
    mockUseInvoice.invoice = mockInvoice
    render(<InvoicePayment />)
    expect(screen.getByRole("button", { name: /cancel invoice/i })).toBeInTheDocument()
  })

  it("cancel button is not shown for non-merchant", () => {
    mockUseWallet.connected = true
    mockUseWallet.address = "GBDXOEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
    mockUseInvoice.invoice = mockInvoice
    render(<InvoicePayment />)
    expect(screen.queryByRole("button", { name: /cancel invoice/i })).not.toBeInTheDocument()
  })

  it("cancel button is not shown when invoice is not pending", () => {
    mockUseWallet.connected = true
    mockUseWallet.address = mockInvoice.merchant
    mockUseInvoice.invoice = { ...mockInvoice, status: "Paid" }
    render(<InvoicePayment />)
    expect(screen.queryByRole("button", { name: /cancel invoice/i })).not.toBeInTheDocument()
  })
})

describe("InvoicePayment — confirmation modals", () => {
  it("shows pay confirmation modal when pay is clicked", async () => {
    mockUseWallet.connected = true
    mockUseWallet.address = "GDR7WUDWIKWVBCUBVYLOGT3TJF5FGNQU5U7TACDDA2ZIQUETGGUET5XT"
    mockUseInvoice.invoice = mockInvoice
    const user = userEvent.setup()

    render(<InvoicePayment />)
    await user.click(screen.getByRole("button", { name: /pay invoice #42/i }))
    expect(screen.getByTestId("pay-confirmation-modal")).toBeInTheDocument()
  })

  it("calls pay when pay confirmation is confirmed", async () => {
    const pay = vi.fn().mockResolvedValue({ success: true, transaction_hash: "hash123" })
    mockUseWallet.connected = true
    mockUseWallet.address = "GDR7WUDWIKWVBCUBVYLOGT3TJF5FGNQU5U7TACDDA2ZIQUETGGUET5XT"
    mockUseInvoice.invoice = mockInvoice
    mockUseInvoice.pay = pay
    const user = userEvent.setup()

    render(<InvoicePayment />)
    await user.click(screen.getByRole("button", { name: /pay invoice #42/i }))
    await user.click(screen.getByTestId("confirm-pay-btn"))
    expect(pay).toHaveBeenCalledOnce()
  })

  it("shows success result after successful payment", async () => {
    const pay = vi.fn().mockResolvedValue({ success: true, transaction_hash: "hash123" })
    mockUseWallet.connected = true
    mockUseWallet.address = "GDR7WUDWIKWVBCUBVYLOGT3TJF5FGNQU5U7TACDDA2ZIQUETGGUET5XT"
    mockUseInvoice.invoice = mockInvoice
    mockUseInvoice.pay = pay
    const user = userEvent.setup()

    render(<InvoicePayment />)
    await user.click(screen.getByRole("button", { name: /pay invoice #42/i }))
    await user.click(screen.getByTestId("confirm-pay-btn"))
    expect(await screen.findByText(/payment successful/i)).toBeInTheDocument()
  })

  it("shows cancel confirmation modal when cancel is clicked", async () => {
    mockUseWallet.connected = true
    mockUseWallet.address = mockInvoice.merchant
    mockUseInvoice.invoice = mockInvoice
    const user = userEvent.setup()

    render(<InvoicePayment />)
    await user.click(screen.getByRole("button", { name: /cancel invoice/i }))
    expect(screen.getByTestId("cancel-confirmation-modal")).toBeInTheDocument()
  })

  it("calls cancel when cancel confirmation is confirmed", async () => {
    const cancel = vi.fn().mockResolvedValue({ success: true, transaction_hash: "hash456" })
    mockUseWallet.connected = true
    mockUseWallet.address = mockInvoice.merchant
    mockUseInvoice.invoice = mockInvoice
    mockUseInvoice.cancel = cancel
    const user = userEvent.setup()

    render(<InvoicePayment />)
    await user.click(screen.getByRole("button", { name: /cancel invoice/i }))
    await user.click(screen.getByTestId("confirm-cancel-btn"))
    expect(cancel).toHaveBeenCalledOnce()
    expect(await screen.findByText(/payment successful/i)).toBeInTheDocument()
  })

  it("shows error result when pay fails", async () => {
    const pay = vi.fn().mockResolvedValue({ success: false, error: "Invoice already paid" })
    mockUseWallet.connected = true
    mockUseWallet.address = "GDR7WUDWIKWVBCUBVYLOGT3TJF5FGNQU5U7TACDDA2ZIQUETGGUET5XT"
    mockUseInvoice.invoice = mockInvoice
    mockUseInvoice.pay = pay
    const user = userEvent.setup()

    render(<InvoicePayment />)
    await user.click(screen.getByRole("button", { name: /pay invoice #42/i }))
    await user.click(screen.getByTestId("confirm-pay-btn"))
    expect(await screen.findByText(/operation failed: Invoice already paid/i)).toBeInTheDocument()
  })
})

describe("InvoicePayment — connect button disabled while connecting", () => {
  it("shows connecting state", () => {
    mockUseWallet.connecting = true
    mockUseInvoice.invoice = mockInvoice
    render(<InvoicePayment />)
    const btn = screen.getByRole("button", { name: /connect wallet/i })
    expect(btn).toBeDisabled()
    expect(btn).toHaveTextContent("Connecting...")
  })
})
