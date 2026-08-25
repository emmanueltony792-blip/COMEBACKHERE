/**
 * Correlation ID middleware (issue #224)
 *
 * Attaches a unique `X-Request-Id` header to every request and response so
 * that a single request can be traced across logs, the treasury indexer, and
 * webhook delivery.
 *
 * Behaviour:
 *  - If the incoming request already carries an `X-Request-Id` header, that
 *    value is preserved and echoed back on the response (client-supplied ID).
 *  - Otherwise a new UUID v4 is generated and set on both the request and the
 *    response.
 *
 * The ID is stored on `res.locals.requestId` so route handlers and other
 * middleware can include it in log lines:
 *
 *   console.log(`[requestId=${res.locals.requestId}] processing invoice`)
 */

import { type Request, type Response, type NextFunction } from "express"
import { randomUUID } from "node:crypto"

export function correlationIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incomingId = req.headers["x-request-id"]
  // Only accept a single string value; ignore arrays (malformed headers)
  const requestId =
    typeof incomingId === "string" && incomingId.trim() !== ""
      ? incomingId.trim()
      : randomUUID()

  // Make the ID available to downstream handlers and logging
  res.locals.requestId = requestId

  // Echo the ID on the response so callers can correlate client-side
  res.setHeader("X-Request-Id", requestId)

  next()
}
