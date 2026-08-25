import { useCallback, useEffect, useState } from "react"
import "./ThresholdConfig.css"

const API_BASE = "/api"

interface SignerInfo {
  address: string
  weight: number
}

interface QuorumPreview {
  requiredSigners: SignerInfo[]
  isFeasible: boolean
  totalWeightAvailable: number
}

function calculateQuorumPreview(threshold: number, signers: SignerInfo[]): QuorumPreview {
  // Sort signers by weight in descending order to find minimum set needed
  const sortedSigners = [...signers].sort((a, b) => b.weight - a.weight)

  let accumulatedWeight = 0
  const requiredSigners: SignerInfo[] = []

  for (const signer of sortedSigners) {
    accumulatedWeight += signer.weight
    requiredSigners.push(signer)
    if (accumulatedWeight >= threshold) {
      break
    }
  }

  const totalWeightAvailable = signers.reduce((sum, s) => sum + s.weight, 0)
  const isFeasible = accumulatedWeight >= threshold

  return { requiredSigners, isFeasible, totalWeightAvailable }
}

export default function ThresholdConfig() {
  const [current, setCurrent] = useState<number | null>(null)
  const [inputValue, setInputValue] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [signers, setSigners] = useState<SignerInfo[]>([])
  const [signersLoading, setSignersLoading] = useState(true)

  const fetchThreshold = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await fetch(`${API_BASE}/treasury/threshold`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
      }
      const data: { threshold: number } = await res.json()
      setCurrent(data.threshold)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load threshold")
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchSigners = useCallback(async () => {
    try {
      setSignersLoading(true)
      const res = await fetch(`${API_BASE}/treasury/signers`)
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const data: SignerInfo[] = await res.json()
      setSigners(data)
    } catch (e: unknown) {
      // Don't set error state for signers - it's optional for quorum preview
      console.error("Failed to load signers:", e)
    } finally {
      setSignersLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchThreshold()
    void fetchSigners()
  }, [fetchThreshold, fetchSigners])

  const parsed = inputValue !== "" ? Number(inputValue) : null
  const isValid = parsed !== null && Number.isInteger(parsed) && parsed > 0

  // Calculate quorum preview if valid input and signers available
  const quorumPreview = isValid && parsed !== null && signers.length > 0
    ? calculateQuorumPreview(parsed, signers)
    : null

  // Block submission when the requested threshold exceeds total signer weight.
  const exceedsWeight = quorumPreview !== null && !quorumPreview.isFeasible

  const handleSave = async () => {
    if (!isValid || parsed === null) {
      setError("Threshold must be a positive integer")
      return
    }
    if (exceedsWeight && quorumPreview !== null) {
      setError(
        `Threshold (${parsed}) exceeds total signer weight (${quorumPreview.totalWeightAvailable}). ` +
          `The treasury would be permanently locked. Add more signers or choose a lower value.`,
      )
      return
    }

    setSaving(true)
    setError(null)
    setSuccess(null)

    try {
      const res = await fetch(`${API_BASE}/treasury/threshold`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threshold: parsed }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
      }
      const updated = (body as { threshold: number }).threshold
      setCurrent(updated)
      setInputValue("")
      setSuccess(
        `Threshold updated to ${updated}.` +
          ((body as { tx_hash?: string }).tx_hash
            ? ` Transaction: ${(body as { tx_hash: string }).tx_hash.slice(0, 12)}…`
            : ""),
      )
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to update threshold")
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="settings-panel">
      <div>
        <h3 className="settings-panel__title">Approval threshold</h3>
        <p className="settings-panel__description">
          Minimum combined signer weight required to execute a treasury settlement.
          {loading
            ? " Loading current value…"
            : current !== null
              ? ` Current: ${current}.`
              : ""}
        </p>
      </div>

      <div className="threshold-form">
        <div className="threshold-form__row">
          <label className="form-label" htmlFor="threshold-value">
            New threshold
          </label>
          <input
            id="threshold-value"
            className="form-input threshold-form__value"
            type="number"
            min="1"
            step="1"
            placeholder="e.g. 2"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            disabled={loading || saving}
          />
        </div>

        {isValid && parsed !== null && current !== null && parsed !== current && (
          <p className="settings-panel__description">
            Preview: threshold will change from {current} → {parsed}
          </p>
        )}

        {quorumPreview && (
          <div className="threshold-quorum-preview">
            <h4 className="threshold-quorum-preview__title">Quorum Preview</h4>
            {!quorumPreview.isFeasible ? (
              <p className="threshold-quorum-preview__warning">
                ⚠️ This threshold ({parsed}) is unreachable with current signers (max weight: {quorumPreview.totalWeightAvailable})
              </p>
            ) : (
              <>
                <p className="threshold-quorum-preview__summary">
                  Required signers: {quorumPreview.requiredSigners.length} out of {signers.length}
                </p>
                <ul className="threshold-quorum-preview__signers">
                  {quorumPreview.requiredSigners.map((signer) => (
                    <li key={signer.address} className="threshold-quorum-preview__signer">
                      <span className="threshold-quorum-preview__signer-address">
                        {signer.address.slice(0, 8)}…{signer.address.slice(-6)}
                      </span>
                      <span className="threshold-quorum-preview__signer-weight">Weight: {signer.weight}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        <button
          type="button"
          className="btn btn--primary threshold-form__save"
          disabled={loading || saving || !isValid || exceedsWeight}
          onClick={() => void handleSave()}
        >
          {saving ? "Saving…" : "Save threshold"}
        </button>
      </div>

      {error && <p className="form-error threshold-form__feedback">{error}</p>}
      {success && <p className="form-success threshold-form__feedback">{success}</p>}
    </section>
  )
}
