import { useEffect, useState } from 'react'
import { describeArgs } from '../lib/chat-model.ts'
import { formatCountdown, fractionLeft, secondsLeft } from '../lib/countdown.ts'
import type { Approval } from '../state/useWorkspace.ts'
import { Icon } from './icons.tsx'
import { Button, Sheet } from './ui.tsx'

const ORIGIN_LABEL: Record<string, string> = { pc: 'Demandé depuis le PC', background: 'Demandé par une tâche en arrière-plan' }

/** Re-renders every second while `active`, for the countdown. */
export function useNow(active: boolean, every = 1000): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(t)
  }, [active, every])
  return now
}

/**
 * An action waits for the owner's decision: a sheet with a countdown ring (no answer in time means
 * refused, as on the PC). Accepting still asks for the fingerprint, the face or the PIN first (the
 * caller does that); closing the sheet only hides it, the request stays pending.
 */
export function ApprovalSheet({
  approval,
  waiting,
  deciding,
  onDecide,
  onClose
}: {
  approval: Approval | undefined
  /** How many others wait after this one. */
  waiting: number
  deciding: boolean
  onDecide: (a: Approval, ok: boolean) => void
  onClose: () => void
}) {
  const now = useNow(Boolean(approval))
  if (!approval) return <Sheet open={false} onClose={onClose}>{null}</Sheet>
  const left = secondsLeft(approval.expiresAt, now)
  const share = fractionLeft(approval.expiresAt, approval.seenAt ?? approval.expiresAt - 300_000, now)
  const urgent = left <= 30
  return (
    <Sheet open onClose={onClose} label="Demande d’accord">
      <div className="approval">
        <div className="approval-head">
          <span className={`ring ${urgent ? 'urgent' : ''}`} role="timer" aria-label={`Il reste ${formatCountdown(left)}`}>
            <svg viewBox="0 0 44 44" aria-hidden="true">
              <circle className="ring-track" cx="22" cy="22" r="19" />
              <circle className="ring-bar" cx="22" cy="22" r="19" strokeDasharray={`${(share * 119.4).toFixed(1)} 119.4`} />
            </svg>
            <b>{formatCountdown(left)}</b>
          </span>
          <div>
            <h2>Jarod demande votre accord</h2>
            <p className="muted">{approval.origin ? (ORIGIN_LABEL[approval.origin] ?? '') : 'Une action attend votre décision.'}</p>
          </div>
        </div>
        <p className="approval-desc">{approval.description}</p>
        <div className="approval-tool">
          <Icon name="tool" size={16} />
          <code>{approval.call.name}</code>
        </div>
        <pre className="approval-args">{describeArgs(approval.call.args)}</pre>
        <p className="muted small">
          Une décision pour cette action seulement. Sans réponse avant {new Date(approval.expiresAt).toLocaleTimeString()}, c’est refusé.
          {waiting > 0 && ` ${waiting} autre${waiting > 1 ? 's' : ''} demande${waiting > 1 ? 's' : ''} ensuite.`}
        </p>
        <div className="approval-actions">
          <Button tone="outlined" disabled={deciding} feel="tap" onClick={() => onDecide(approval, false)}>
            Refuser
          </Button>
          <Button tone="filled" icon="lock" disabled={deciding || left === 0} feel="confirm" onClick={() => onDecide(approval, true)}>
            Autoriser
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
