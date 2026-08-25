import { useState, useEffect, useCallback, useRef } from 'react'
import { Dispute, DisputeOutcome } from '../types/dispute'

const API_BASE = '/api'

export function useDisputes() {
  const [disputes, setDisputes] = useState<Dispute[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [weightChanged, setWeightChanged] = useState(false)

  // Keep a ref of the previous dispute weights so we can detect changes
  const prevWeightsRef = useRef<Record<number, number>>({})

  // Flash the weightChanged indicator for 3 seconds then reset
  const weightChangedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const triggerWeightChanged = useCallback(() => {
    setWeightChanged(true)
    if (weightChangedTimerRef.current) clearTimeout(weightChangedTimerRef.current)
    weightChangedTimerRef.current = setTimeout(() => {
      setWeightChanged(false)
    }, 3000)
  }, [])

  const fetchDisputes = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await fetch(`${API_BASE}/treasury/disputes`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const incoming: Dispute[] = await res.json()

      // Compare resolution_weight totals against previous values to detect change
      const prev = prevWeightsRef.current
      let changed = false
      for (const d of incoming) {
        if (
          prev[d.settlement_id] !== undefined &&
          prev[d.settlement_id] !== d.resolution_weight
        ) {
          changed = true
          break
        }
      }

      // Update the previous-weights snapshot
      const next: Record<number, number> = {}
      for (const d of incoming) next[d.settlement_id] = d.resolution_weight
      prevWeightsRef.current = next

      setDisputes(incoming)
      setLastUpdated(new Date())

      if (changed) triggerWeightChanged()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to fetch disputes')
    } finally {
      setLoading(false)
    }
  }, [triggerWeightChanged])

  useEffect(() => {
    fetchDisputes()
    const interval = setInterval(fetchDisputes, 15_000)
    return () => {
      clearInterval(interval)
      if (weightChangedTimerRef.current) clearTimeout(weightChangedTimerRef.current)
    }
  }, [fetchDisputes])

  const voteDispute = useCallback(async (settlementId: number, vote: DisputeOutcome) => {
    const res = await fetch(`${API_BASE}/treasury/vote-dispute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settlement_id: settlementId, vote }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const updated: Dispute = await res.json()
    setDisputes(prev => prev.map(d => d.settlement_id === settlementId ? updated : d))
    // Voting always constitutes a weight change worth indicating
    triggerWeightChanged()
    setLastUpdated(new Date())
    // Keep the previous-weights snapshot consistent
    prevWeightsRef.current[updated.settlement_id] = updated.resolution_weight
  }, [triggerWeightChanged])

  return { disputes, loading, error, voteDispute, refresh: fetchDisputes, lastUpdated, weightChanged }
}
