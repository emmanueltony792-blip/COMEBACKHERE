import { useState } from 'react'
import { Dispute, DisputeOutcome } from '../../types/dispute'
import { useDisputes } from '../../hooks/useDisputes'
import './DisputeVotingPanel.css'

const CURRENT_SIGNER = import.meta.env.VITE_SIGNER_1 ?? ''

function shorten(addr: string): string {
  if (!addr || addr.length < 12) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function OutcomeBadge({ outcome }: { outcome: DisputeOutcome }) {
  return (
    <span className={`outcome-badge outcome-badge--${outcome === 'ResolvedClaimant' ? 'claimant' : 'counterparty'}`}>
      {outcome === 'ResolvedClaimant' ? 'Resolved: Claimant' : 'Resolved: Counterparty'}
    </span>
  )
}

function ResolutionBar({ current, threshold }: { current: number; threshold: number }) {
  const pct = Math.min(100, Math.round((current / threshold) * 100))
  return (
    <div className="resolution-bar-wrap">
      <div className="resolution-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${current} of ${threshold} resolution votes`}>
        <div className="resolution-bar__fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="resolution-bar__label">{current} / {threshold}</span>
    </div>
  )
}

function DisputeCard({ dispute, onVote }: { dispute: Dispute; onVote: (id: number, v: DisputeOutcome) => Promise<void> }) {
  const [voting, setVoting] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const hasVoted = dispute.votes.some(v => v.signer === CURRENT_SIGNER)
  const resolved = dispute.outcome !== null

  const handleVote = async (vote: DisputeOutcome) => {
    setVoting(true)
    setErr(null)
    try {
      await onVote(dispute.settlement_id, vote)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setVoting(false)
    }
  }

  return (
    <div className="dispute-card">
      <div className="dispute-card__header">
        <span className="dispute-card__id">Settlement #{dispute.settlement_id}</span>
        {resolved && <OutcomeBadge outcome={dispute.outcome!} />}
      </div>

      <div className="dispute-card__section">
        <span className="dispute-card__label">Resolution weight</span>
        <ResolutionBar current={dispute.resolution_weight} threshold={dispute.threshold} />
      </div>

      <div className="dispute-card__votes">
        <div className="dispute-card__vote-col">
          <span className="dispute-card__label">Claimant ({dispute.claimant_weight})</span>
        </div>
        <div className="dispute-card__vote-col">
          <span className="dispute-card__label">Counterparty ({dispute.counterparty_weight})</span>
        </div>
      </div>

      {!resolved && (
        <div className="dispute-card__actions" role="group" aria-label={`Vote on settlement #${dispute.settlement_id}`}>
          <button
            className="vote-btn vote-btn--claimant"
            disabled={hasVoted || voting}
            onClick={() => handleVote('ResolvedClaimant')}
            aria-label={`Vote in favor of claimant for settlement #${dispute.settlement_id}`}
          >
            Vote Claimant
          </button>
          <button
            className="vote-btn vote-btn--counterparty"
            disabled={hasVoted || voting}
            onClick={() => handleVote('ResolvedCounterparty')}
            aria-label={`Vote in favor of counterparty for settlement #${dispute.settlement_id}`}
          >
            Vote Counterparty
          </button>
        </div>
      )}

      {hasVoted && !resolved && <p className="dispute-card__voted" aria-live="polite">You have voted.</p>}
      {err && <p className="dispute-card__error" role="alert">{err}</p>}
    </div>
  )
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export default function DisputeVotingPanel() {
  const { disputes, loading, error, voteDispute, lastUpdated, weightChanged } = useDisputes()

  if (loading && disputes.length === 0) return <div className="dispute-panel"><p>Loading disputes...</p></div>
  if (error && disputes.length === 0) return <div className="dispute-panel"><p className="dispute-panel__error">Error: {error}</p></div>

  const open = disputes.filter(d => d.outcome === null)
  const resolved = disputes.filter(d => d.outcome !== null)

  return (
    <div className="dispute-panel">
      <div className="dispute-panel__header">
        <h2 className="dispute-panel__title">Dispute Resolution</h2>

        {/* Real-time update indicator */}
        <div className="dispute-panel__live" aria-live="polite" aria-atomic="true">
          {weightChanged && (
            <span className="dispute-panel__update-badge" role="status">
              ● Weights updated
            </span>
          )}
          {lastUpdated && (
            <span className="dispute-panel__last-updated">
              Last synced: {formatTime(lastUpdated)}
            </span>
          )}
        </div>
      </div>

      {open.length === 0 && resolved.length === 0 && <p>No disputes found.</p>}
      {open.length > 0 && (
        <section>
          <h3 className="dispute-panel__section-title">Open Disputes</h3>
          {open.map(d => <DisputeCard key={d.settlement_id} dispute={d} onVote={voteDispute} />)}
        </section>
      )}
      {resolved.length > 0 && (
        <section>
          <h3 className="dispute-panel__section-title">Resolved</h3>
          {resolved.map(d => <DisputeCard key={d.settlement_id} dispute={d} onVote={voteDispute} />)}
        </section>
      )}
    </div>
  )
}
