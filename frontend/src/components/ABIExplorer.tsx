import { useState, useMemo } from 'react'

interface ABIContract {
  contract: string
  version: string
  functions: string[]
}

const contracts: ABIContract[] = [
  {
    contract: 'invoice',
    version: '1.1.0',
    functions: [
      'initialize',
      'create_invoice',
      'mark_paid',
      'get_invoice',
      'get_invoice_status',
      'cancel_invoice',
      'request_refund',
      'batch_expire(offset: u32, limit: u32, returns: u32)',
      'pause',
      'unpause',
      'set_grace_window',
      'get_grace_window',
      'release_escrow',
    ],
  },
  {
    contract: 'treasury',
    version: '1.0.0',
    functions: [
      'initialize',
      'set_signer',
      'propose_settlement',
      'propose_partial_settlement',
      'approve_settlement',
      'approve_partial_settlement',
      'execute_settlement',
      'partially_execute_settlement',
      'cancel_settlement',
      'get_pending_settlements',
      'get_pending_settlements_page',
      'get_settlement',
      'update_threshold',
      'pause',
      'unpause',
      'raise_dispute',
      'resolve_dispute',
      'vote_dispute_resolution',
      'deposit',
      'withdraw',
      'add_allowed_token',
      'remove_allowed_token',
      'get_allowed_tokens',
      'propose_signer_rotation',
      'approve_signer_rotation',
      'update_merchant_payout_address',
      'get_merchant_payout_address',
      'hold_settlement',
      'release_hold',
    ],
  },
  {
    contract: 'compliance',
    version: '1.0.0',
    functions: [
      'initialize',
      'is_allowed',
      'allow_address',
      'block_address',
      'allow_address_until',
      'transfer_admin',
      'accept_admin',
      'clear_address',
      'pause',
      'unpause',
    ],
  },
]

export default function ABIExplorer() {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [query, setQuery] = useState('')
  const [contractFilter, setContractFilter] = useState('all')

  const toggle = (contract: string) => {
    setExpanded(prev => ({ ...prev, [contract]: !prev[contract] }))
  }

  const normalised = query.trim().toLowerCase()

  const filtered = useMemo(() => {
    return contracts
      .filter(c => contractFilter === 'all' || c.contract === contractFilter)
      .map(c => {
        const matchingFns = normalised
          ? c.functions.filter(fn => fn.toLowerCase().includes(normalised))
          : c.functions
        return { ...c, functions: matchingFns }
      })
      .filter(c => c.functions.length > 0 || !normalised)
  }, [normalised, contractFilter])

  // Auto-expand contracts when there is an active search so results are visible
  const effectiveExpanded = useMemo(() => {
    if (!normalised) return expanded
    const auto: Record<string, boolean> = {}
    filtered.forEach(c => { auto[c.contract] = true })
    return { ...expanded, ...auto }
  }, [normalised, filtered, expanded])

  const totalResults = filtered.reduce((sum, c) => sum + c.functions.length, 0)

  return (
    <div style={{ padding: '20px' }} role="region" aria-label="ABI Explorer">
      <h2>ABI Explorer</h2>
      <p>Deployed contract functions reference</p>

      {/* Search and filter controls */}
      <div
        style={{
          display: 'flex',
          gap: '12px',
          marginBottom: '20px',
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <label htmlFor="abi-search" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
          Search functions
        </label>
        <input
          id="abi-search"
          type="search"
          placeholder="Search functions…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          aria-label="Search functions"
          style={{
            flex: '1 1 200px',
            padding: '8px 12px',
            border: '1px solid var(--color-input-border, #ccc)',
            borderRadius: '4px',
            fontSize: '0.9rem',
            background: 'var(--color-input-bg, #fff)',
            color: 'var(--color-text, inherit)',
            outline: 'none',
          }}
        />

        <label htmlFor="abi-contract-filter" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
          Filter by contract
        </label>
        <select
          id="abi-contract-filter"
          value={contractFilter}
          onChange={e => setContractFilter(e.target.value)}
          aria-label="Filter by contract"
          style={{
            padding: '8px 12px',
            border: '1px solid var(--color-input-border, #ccc)',
            borderRadius: '4px',
            fontSize: '0.9rem',
            background: 'var(--color-input-bg, #fff)',
            color: 'var(--color-text, inherit)',
            cursor: 'pointer',
          }}
        >
          <option value="all">All contracts</option>
          {contracts.map(c => (
            <option key={c.contract} value={c.contract}>
              {c.contract}
            </option>
          ))}
        </select>

        {normalised && (
          <span
            role="status"
            aria-live="polite"
            style={{ fontSize: '0.85rem', color: 'var(--color-text-muted, #888)' }}
          >
            {totalResults} result{totalResults !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Contract panels */}
      {filtered.length === 0 ? (
        <p role="status" style={{ color: 'var(--color-text-muted, #888)', fontStyle: 'italic' }}>
          No functions match your search.
        </p>
      ) : (
        filtered.map(c => (
          <div
            key={c.contract}
            style={{ marginBottom: '16px', border: '1px solid #ccc', borderRadius: '4px' }}
          >
            <button
              type="button"
              onClick={() => toggle(c.contract)}
              aria-expanded={!!effectiveExpanded[c.contract]}
              aria-controls={`abi-panel-${c.contract}`}
              style={{
                padding: '12px',
                cursor: 'pointer',
                background: '#f9f9f9',
                fontWeight: 'bold',
                width: '100%',
                border: 'none',
                textAlign: 'left',
                fontSize: 'inherit',
              }}
            >
              {c.contract} (v{c.version}) — {c.functions.length} function{c.functions.length !== 1 ? 's' : ''}
              {normalised && c.functions.length !== contracts.find(x => x.contract === c.contract)?.functions.length
                ? ` (filtered from ${contracts.find(x => x.contract === c.contract)?.functions.length})`
                : ''}
            </button>
            {effectiveExpanded[c.contract] && (
              <ul
                id={`abi-panel-${c.contract}`}
                role="list"
                style={{ margin: 0, padding: '12px 24px' }}
              >
                {c.functions.map((fn, i) => (
                  <li
                    key={i}
                    style={{ fontFamily: 'monospace', fontSize: '14px', marginBottom: '4px' }}
                  >
                    {normalised ? (
                      <HighlightMatch text={fn} query={normalised} />
                    ) : (
                      fn
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))
      )}
    </div>
  )
}

/** Highlights the matching substring within a function name */
function HighlightMatch({ text, query }: { text: string; query: string }) {
  const idx = text.toLowerCase().indexOf(query)
  if (idx === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ background: 'var(--color-primary-soft, #dbeafe)', borderRadius: '2px', padding: '0 1px' }}>
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  )
}
