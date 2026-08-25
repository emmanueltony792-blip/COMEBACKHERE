import { z } from "zod"
import { Keypair } from "stellar-sdk"

function isValidStellarAddress(addr: string): boolean {
  try {
    Keypair.fromPublicKey(addr)
    return true
  } catch {
    return false
  }
}

const stellarAddress = z.string().min(1).refine(isValidStellarAddress, {
  message: "Must be a valid Stellar public key",
})

const positiveInt = z
  .number({ message: "Must be a positive integer" })
  .int("Must be a positive integer")
  .positive("Must be a positive integer")

const futureTimestamp = z
  .number()
  .int("due_date must be a positive Unix timestamp")
  .positive("due_date must be a positive Unix timestamp")
  .refine((val) => val > Math.floor(Date.now() / 1000), {
    message: "due_date must be in the future",
  })

export const createInvoiceSchema = z.object({
  merchant_address: z
    .string()
    .min(1, "merchant_address is required")
    .refine(isValidStellarAddress, "merchant_address must be a valid Stellar public key"),
  token: z.string().min(1, "token is required"),
  amount: z
    .number({ message: "amount must be a positive number" })
    .positive("amount must be a positive number"),
  due_date: futureTimestamp,
})

export const invoiceIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, "id must be a positive integer"),
})

export const releaseEscrowIdParamSchema = z.object({
  id: z
    .string()
    .regex(/^\d+$/, "id must be a positive integer")
    .refine((val) => parseInt(val, 10) > 0, "id must be a positive integer"),
})

export const allowBodySchema = z.object({
  address: stellarAddress,
  until: z
    .number({ message: "until must be a positive Unix timestamp" })
    .int("until must be a positive Unix timestamp")
    .positive("until must be a positive Unix timestamp")
    .optional(),
})

export const blockBodySchema = z.object({
  address: stellarAddress,
})

export const settlementIdSchema = z.object({
  settlement_id: positiveInt,
})

export const executeSettlementSchema = z.object({
  settlement_id: positiveInt,
  token_contract: z.string().optional(),
})

export const escalateHoldSchema = z.object({
  settlement_id: positiveInt,
  reason: z.string().max(512).optional(),
})

export const graceWindowSchema = z.object({
  grace_window_seconds: z
    .number({ message: "grace_window_seconds must be a positive integer" })
    .int("grace_window_seconds must be a positive integer")
    .positive("grace_window_seconds must be a positive integer")
    .max(2_592_000, "grace_window_seconds must not exceed 2592000 (30 days)"),
})

export const thresholdSchema = z.object({
  threshold: positiveInt,
})

export const voteBodySchema = z.object({
  signer_address: z
    .string()
    .min(1, "signer_address is required")
    .refine(isValidStellarAddress, "signer_address must be a valid Stellar public key"),
  vote: z.enum(["ResolvedClaimant", "ResolvedCounterparty"], {
    errorMap: () => ({ message: "vote must be 'ResolvedClaimant' or 'ResolvedCounterparty'" }),
  }),
  weight: z
    .number({ message: "weight must be a positive integer" })
    .int("weight must be a positive integer")
    .positive("weight must be a positive integer")
    .default(1),
})

export const createDisputeSchema = z.object({
  claimant_address: stellarAddress,
  settlement_id: z
    .string()
    .min(1, "settlement_id is required")
    .regex(/^\d+$/, "settlement_id must be a positive integer string"),
  reason: z.string().optional(),
})

export const analyticsQuerySchema = z
  .object({
    start_date: z
      .string()
      .optional()
      .transform((val) => (val ? parseInt(val, 10) : undefined))
      .pipe(z.number().finite("Invalid start_date timestamp").optional()),
    end_date: z
      .string()
      .optional()
      .transform((val) => (val ? parseInt(val, 10) : undefined))
      .pipe(z.number().finite("Invalid end_date timestamp").optional()),
  })
  .refine(
    (data) => {
      if (data.start_date && data.end_date) {
        return data.start_date <= data.end_date
      }
      return true
    },
    { message: "start_date must be before end_date" },
  )
