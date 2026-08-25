import { z } from "zod"
import type { Request, Response, NextFunction } from "express"

type RequestPart = "body" | "params" | "query"

function makeValidator(part: RequestPart) {
  return (schema: z.ZodTypeAny) =>
    (req: Request, res: Response, next: NextFunction) => {
      const result = schema.safeParse(req[part])
      if (!result.success) {
        const details = result.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        }))
        const error = details.map((d) => `${d.field}: ${d.message}`).join("; ")
        res.status(400).json({ error, details })
        return
      }
      if (part === "body") {
        req.body = result.data
      }
      next()
    }
}

export const validateBody = makeValidator("body")
export const validateParams = makeValidator("params")
export const validateQuery = makeValidator("query")
