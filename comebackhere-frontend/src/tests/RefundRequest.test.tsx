import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi } from "vitest"
import { RefundRequest } from "../components/RefundRequest"
import type { Invoice, InvoiceStatus } from "../types"

vi.mock("../components/RefundConfirmationModal", () => ({
  RefundConfirmationModal: ({ onConfirm, onCancel, submitting }: any) => (
    <div data-testid="refund-confirmation-modal">
      <button onClick={onConfirm} disabled={submitting} data-testid="confirm-refund-btn">
        {submitting ? "Processing..." : "Confirm Refund"}
      </button>
      <button onClick={onCancel} data-testid="cancel-refund-btn">Cancel</button>
    </div>
  ),
}))

const PAYER_ADDRESS = "GBDXOEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
const MERCHANT_ADDRESS = "GDR7WUDWIKWVBCUBVYLOGT3TJF5FGNQU5U7TACDDA2ZIQUETGGUET5XT"

const paidInvoice: Invoice = {
  id: "42",
  merchant: MERCHANT_ADDRESS,
  payer: PAYER_ADDRESS,
  amount_usdc: "1000",
  gross_usdc: "1050",
  expires_at: Math.floor(Date.now() / 1000) + 86400,
  status: "Paid" as InvoiceStatus,
  paid_at: Math.floor(Date.now() / 1000),
  metadata_hash: null,
  payment_link_hash: null,
}

const pendingInvoice: Invoice = {
  ...paidInvoice,
  status: "Pending" as InvoiceStatus,
  paid_at: null,
}

const refundRequestedInvoice: Invoice = {
  ...paidInvoice,
  status: "RefundRequested" as InvoiceStatus,
}

describe("RefundRequest", () => {
  it("renders refund form when invoice is paid and user is payer", () => {
    render(
      <RefundRequest
        invoice={paidInvoice}
        walletAddress={PAYER_ADDRESS}
        onRequestRefund={vi.fn()}
      />
    )
    expect(screen.getByLabelText(/reason for refund/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /request refund/i })).toBeInTheDocument()
  })

  it("does not render refund form when user is not the payer", () => {
    render(
      <RefundRequest
        invoice={paidInvoice}
        walletAddress={MERCHANT_ADDRESS}
        onRequestRefund={vi.fn()}
      />
    )
    expect(screen.queryByLabelText(/reason for refund/i)).not.toBeInTheDocument()
  })

  it("does not render refund form when invoice is not paid", () => {
    render(
      <RefundRequest
        invoice={pendingInvoice}
        walletAddress={PAYER_ADDRESS}
        onRequestRefund={vi.fn()}
      />
    )
    expect(screen.queryByLabelText(/reason for refund/i)).not.toBeInTheDocument()
  })

  it("shows status info when invoice status is RefundRequested", () => {
    render(
      <RefundRequest
        invoice={refundRequestedInvoice}
        walletAddress={PAYER_ADDRESS}
        onRequestRefund={vi.fn()}
      />
    )
    expect(screen.getByText(/refund request has been submitted/i)).toBeInTheDocument()
  })

  it("shows hint about minimum characters", () => {
    render(
      <RefundRequest
        invoice={paidInvoice}
        walletAddress={PAYER_ADDRESS}
        onRequestRefund={vi.fn()}
      />
    )
    expect(screen.getByText(/minimum 10 characters/i)).toBeInTheDocument()
  })
})

describe("RefundRequest — reason validation", () => {
  it("shows error when reason is too short on change", async () => {
    const user = userEvent.setup()
    render(
      <RefundRequest
        invoice={paidInvoice}
        walletAddress={PAYER_ADDRESS}
        onRequestRefund={vi.fn()}
      />
    )
    const textarea = screen.getByLabelText(/reason for refund/i)
    await user.type(textarea, "Short")

    expect(screen.getByRole("alert")).toHaveTextContent("Reason must be at least 10 characters")
  })

  it("shows character counter", async () => {
    const user = userEvent.setup()
    render(
      <RefundRequest
        invoice={paidInvoice}
        walletAddress={PAYER_ADDRESS}
        onRequestRefund={vi.fn()}
      />
    )
    const textarea = screen.getByLabelText(/reason for refund/i)
    await user.type(textarea, "This is a valid reason for refund")

    expect(screen.getByText(/\/ 500 characters/)).toBeInTheDocument()
  })

  it("disables request refund button when reason is empty", () => {
    render(
      <RefundRequest
        invoice={paidInvoice}
        walletAddress={PAYER_ADDRESS}
        onRequestRefund={vi.fn()}
      />
    )
    expect(screen.getByRole("button", { name: /request refund/i })).toBeDisabled()
  })

  it("disables request refund button when reason has error", async () => {
    const user = userEvent.setup()
    render(
      <RefundRequest
        invoice={paidInvoice}
        walletAddress={PAYER_ADDRESS}
        onRequestRefund={vi.fn()}
      />
    )
    const textarea = screen.getByLabelText(/reason for refund/i)
    await user.type(textarea, "Short")

    expect(screen.getByRole("button", { name: /request refund/i })).toBeDisabled()
  })

  it("enables request refund button when reason is valid", async () => {
    const user = userEvent.setup()
    render(
      <RefundRequest
        invoice={paidInvoice}
        walletAddress={PAYER_ADDRESS}
        onRequestRefund={vi.fn()}
      />
    )
    const textarea = screen.getByLabelText(/reason for refund/i)
    await user.type(textarea, "This is a valid reason for requesting a refund")

    expect(screen.getByRole("button", { name: /request refund/i })).toBeEnabled()
  })

  it("sets aria-invalid when reason has error", async () => {
    const user = userEvent.setup()
    render(
      <RefundRequest
        invoice={paidInvoice}
        walletAddress={PAYER_ADDRESS}
        onRequestRefund={vi.fn()}
      />
    )
    const textarea = screen.getByLabelText(/reason for refund/i)
    await user.type(textarea, "Sh")

    expect(textarea).toHaveAttribute("aria-invalid", "true")
  })
})

describe("RefundRequest — submit flow", () => {
  it("shows confirmation modal when request refund is clicked with valid reason", async () => {
    const user = userEvent.setup()
    render(
      <RefundRequest
        invoice={paidInvoice}
        walletAddress={PAYER_ADDRESS}
        onRequestRefund={vi.fn()}
      />
    )
    const textarea = screen.getByLabelText(/reason for refund/i)
    await user.type(textarea, "This is a valid reason for requesting a refund")
    await user.click(screen.getByRole("button", { name: /request refund/i }))

    expect(screen.getByTestId("refund-confirmation-modal")).toBeInTheDocument()
  })

  it("calls onRequestRefund when confirmed", async () => {
    const onRequestRefund = vi.fn().mockResolvedValue({ success: true, transaction_hash: "hash789" })
    const user = userEvent.setup()
    render(
      <RefundRequest
        invoice={paidInvoice}
        walletAddress={PAYER_ADDRESS}
        onRequestRefund={onRequestRefund}
      />
    )
    const textarea = screen.getByLabelText(/reason for refund/i)
    await user.type(textarea, "This is a valid reason for requesting a refund")
    await user.click(screen.getByRole("button", { name: /request refund/i }))
    await user.clear(textarea)
    await user.type(textarea, "Another valid reason after modal appears")
    await user.click(screen.getByTestId("confirm-refund-btn"))

    expect(onRequestRefund).toHaveBeenCalledOnce()
  })

  it("shows success message after successful refund", async () => {
    const onRequestRefund = vi.fn().mockResolvedValue({ success: true, transaction_hash: "hash789" })
    const user = userEvent.setup()
    render(
      <RefundRequest
        invoice={paidInvoice}
        walletAddress={PAYER_ADDRESS}
        onRequestRefund={onRequestRefund}
      />
    )
    const textarea = screen.getByLabelText(/reason for refund/i)
    await user.type(textarea, "This is a valid reason for requesting a refund")
    await user.click(screen.getByRole("button", { name: /request refund/i }))
    await user.clear(textarea)
    await user.type(textarea, "Another valid reason after modal appears")
    await user.click(screen.getByTestId("confirm-refund-btn"))

    expect(await screen.findByText(/refund requested successfully/i)).toBeInTheDocument()
  })

  it("shows error message when refund fails", async () => {
    const onRequestRefund = vi.fn().mockResolvedValue({ success: false, error: "Invoice not paid" })
    const user = userEvent.setup()
    render(
      <RefundRequest
        invoice={paidInvoice}
        walletAddress={PAYER_ADDRESS}
        onRequestRefund={onRequestRefund}
      />
    )
    const textarea = screen.getByLabelText(/reason for refund/i)
    await user.type(textarea, "This is a valid reason for requesting a refund")
    await user.click(screen.getByRole("button", { name: /request refund/i }))
    await user.clear(textarea)
    await user.type(textarea, "Another valid reason after modal appears")
    await user.click(screen.getByTestId("confirm-refund-btn"))

    expect(await screen.findByText(/refund request failed: Invoice not paid/i)).toBeInTheDocument()
  })

  it("does not call onRequestRefund when modal confirm is clicked with empty reason", async () => {
    const onRequestRefund = vi.fn().mockResolvedValue({ success: true })
    const user = userEvent.setup()
    render(
      <RefundRequest
        invoice={paidInvoice}
        walletAddress={PAYER_ADDRESS}
        onRequestRefund={onRequestRefund}
      />
    )
    const textarea = screen.getByLabelText(/reason for refund/i)
    await user.type(textarea, "Valid reason initially")
    await user.click(screen.getByRole("button", { name: /request refund/i }))
    await user.clear(textarea)
    await user.click(screen.getByTestId("confirm-refund-btn"))

    expect(screen.getByRole("alert")).toHaveTextContent("Reason is required")
    expect(onRequestRefund).not.toHaveBeenCalled()
  })

  it("hides refund form after successful submission", async () => {
    const onRequestRefund = vi.fn().mockResolvedValue({ success: true, transaction_hash: "hash789" })
    const user = userEvent.setup()
    render(
      <RefundRequest
        invoice={paidInvoice}
        walletAddress={PAYER_ADDRESS}
        onRequestRefund={onRequestRefund}
      />
    )
    const textarea = screen.getByLabelText(/reason for refund/i)
    await user.type(textarea, "This is a valid reason for requesting a refund")
    await user.click(screen.getByRole("button", { name: /request refund/i }))
    await user.clear(textarea)
    await user.type(textarea, "Another valid reason after modal appears")
    await user.click(screen.getByTestId("confirm-refund-btn"))

    expect(await screen.findByText(/refund requested successfully/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/reason for refund/i)).not.toBeInTheDocument()
  })
})
