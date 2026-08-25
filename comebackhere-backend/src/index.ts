/**
 * Backend entrypoint — Issue #219
 *
 * Handles SIGTERM and SIGINT for graceful shutdown:
 *  1. Stops accepting new connections (server.close)
 *  2. Stops the treasury indexer poll loop
 *  3. Closes the MongoDB connection
 *  4. Applies a hard-timeout safety net so the process always exits
 */

import { createApp } from "./app.js"
import { startTreasuryIndexer, stopTreasuryIndexer } from "./services/treasury-indexer.js"
import { stopIndexer } from "./indexer.js"
import { closeMongo } from "./db/mongo.js"
import type { Server } from "http"

const PORT = process.env.PORT ?? "3000"
/** Hard shutdown timeout in ms — forces exit if clean shutdown hangs. */
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? "10000")

const app = createApp()
startTreasuryIndexer()

const server: Server = app.listen(Number(PORT), () => {
  console.log(`comebackhere-backend listening on port ${PORT}`)
})

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true

  console.log(`[shutdown] received ${signal} — starting graceful shutdown`)

  // Hard-timeout safety net: if clean shutdown takes too long, force exit.
  const hardTimeout = setTimeout(() => {
    console.error("[shutdown] hard timeout reached — forcing exit")
    process.exit(1)
  }, SHUTDOWN_TIMEOUT_MS)
  // Allow the process to exit even if the timer is still pending.
  hardTimeout.unref()

  try {
    // 1. Stop accepting new HTTP connections; wait for in-flight requests.
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
    console.log("[shutdown] HTTP server closed")

    // 2. Stop indexer poll loops.
    stopTreasuryIndexer()
    stopIndexer()
    console.log("[shutdown] indexers stopped")

    // 3. Close MongoDB connection.
    await closeMongo()
    console.log("[shutdown] MongoDB connection closed")

    clearTimeout(hardTimeout)
    console.log("[shutdown] clean exit")
    process.exit(0)
  } catch (err) {
    console.error("[shutdown] error during shutdown:", err)
    process.exit(1)
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT",  () => void shutdown("SIGINT"))
