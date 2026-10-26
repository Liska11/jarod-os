import { useCallback, useEffect, useState } from 'react'
import { EmptyGlass, GlassButton, GlassCard, PageHeader, Pill, Section } from '../../components/ui/glass.tsx'
import { gatewayCall } from '../../store/gateway.ts'

/**
 * « Capacités & Évolution » — la page de pilotage de ce que Jarod-OS sait faire.
 *
 * Quatre sections, toutes en LECTURE de RPC déjà livrés : la confiance des plugins de la plateforme,
 * le registre des capacités, les dépendances d'exécution, les mises à jour connues. Un bouton = un
 * RPC ; les mutations passent par la carte d'accord de l'application (aucune logique métier ici).
 */

interface TrustPlugin {
  name: string
  version: string
  status: string | null
  trust: string | null
  trustKey: string | null
  trustRevoked: boolean
  state: string | null
  tools: string[]
}

interface Capability {
  id: string
  name?: string
  type?: string | null
  version?: string | null
  status?: string
  verdict?: string | null
  hash?: string | null
  source?: string | null
}

interface Dep {
  id: string
  name: string
  installed: boolean
  version: string | null
  critical: boolean
  candidates: unknown[]
}

interface DepState {
  policy?: string
  compatibility?: string
  previous?: { version: string | null } | null
  current?: string | null
  available?: string | null
}

interface Proposal {
  id: string
  name: string
  current: string | null
  available: string | null
  risk: string
  updatePossible: boolean
  recommendation: string
  missing: string[]
}

const POLICY_CYCLE = ['notify', 'auto-safe', 'auto-full', 'manual'] as const
const STATUS_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'muted'> = {
  active: 'ok',
  enabled: 'ok',
  analyzed: 'warn',
  detected: 'muted',
  proposed: 'warn',
  approved: 'warn',
  installing: 'warn',
  disabled: 'muted',
  rolled_back: 'muted',
  failed: 'danger',
  rejected: 'danger',
}
const TRUST_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'muted'> = {
  official: 'ok',
  verified: 'ok',
  community: 'warn',
  local: 'muted',
}

export function CapabilitiesPage() {
  const [trust, setTrust] = useState<TrustPlugin[]>([])
  const [caps, setCaps] = useState<Capability[]>([])
  const [deps, setDeps] = useState<Dep[]>([])
  const [depsState, setDepsState] = useState<Record<string, DepState>>({})
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [lastResult, setLastResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [installed, registry, inventory, state] = await Promise.all([
        gatewayCall<{ plugins?: TrustPlugin[] }>('trust.installed', {}),
        gatewayCall<{ registry?: { capabilities?: Record<string, Capability> } }>('capability.registry', {}),
        gatewayCall<{ components?: Dep[] }>('deps.inventory', {}),
        gatewayCall<{ state?: { components?: Record<string, DepState> } }>('deps.state', {}),
      ])
      setTrust(installed?.plugins ?? [])
      setCaps(Object.values(registry?.registry?.capabilities ?? {}))
      setDeps(inventory?.components ?? [])
      setDepsState(state?.state?.components ?? {})
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = useCallback(
    async (method: string, params: Record<string, unknown>) => {
      setBusy(true)
      setLastResult(`${method}…`)
      try {
        const result = await gatewayCall<Record<string, unknown>>(method, params)
        setLastResult(`${method} : ${JSON.stringify(result).slice(0, 220)}`)
        setError(null)
      } catch (e) {
        setLastResult(`${method} : refusé`)
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
        await refresh()
      }
    },
    [refresh],
  )

  const verify = useCallback(async (id: string) => {
    try {
      const proposal = await gatewayCall<Proposal>('deps.propose', { id })
      setProposals(previous => [proposal, ...previous.filter(p => p.id !== id)])
      setLastResult(`proposition pour ${proposal.name} : risque ${proposal.risk}${proposal.missing.length ? ` — manque : ${proposal.missing.join('; ')}` : ''}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  return (
    <div className="page-enter flex h-full flex-col">
      <PageHeader icon="capabilities" title="Capacités & Évolution" subtitle="Ce que Jarod-OS sait faire, d'où cela vient, et ce qui peut être mis à jour." actions={<GlassButton size="sm" disabled={busy} onClick={() => void refresh()}>Rafraîchir</GlassButton>} />
      {lastResult && (
        <p className="mx-6 mb-2 rounded-lg border border-line/40 bg-surface/40 px-3 py-2 text-[12.5px] text-fg-3" data-testid="cap-last-result">
          {lastResult}
        </p>
      )}
      {error && (
        <p className="mx-6 mb-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px]" data-testid="cap-error">
          {error}
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-6">
        <Section title="Confiance">
          <p className="mb-2 text-[12.5px] text-fg-3" data-testid="trust-count">
            {trust.length} plugin(s) de la plateforme — niveau de la clé qui a signé chaque plugin ; une clé révoquée est signalée.
          </p>
          {trust.length === 0 ? (
            <EmptyGlass icon="capabilities" title="Aucun plugin de plateforme" description="Les plugins approuvés apparaîtront ici avec leur niveau de confiance." />
          ) : (
            <div className="flex flex-col gap-2">
              {trust.map(plugin => (
                <GlassCard key={plugin.name} className="flex items-center gap-3 px-4 py-2.5" data-testid={`trust-row-${plugin.name}`}>
                  <strong className="min-w-[120px] text-[13px] font-semibold">{plugin.name}</strong>
                  <span className="font-mono text-[11.5px] text-fg-3">v{plugin.version}</span>
                  <span className="text-[12px] text-fg-3">{plugin.status ?? '—'}</span>
                  <span className="flex-1" />
                  <span data-badge={plugin.trust ?? 'inconnu'}>
                    <Pill tone={TRUST_TONE[plugin.trust ?? ''] ?? 'muted'}>{plugin.trust ?? 'inconnu'}</Pill>
                  </span>
                  {plugin.trustRevoked && (
                    <span data-badge="cle-revoquee">
                      <Pill tone="danger">clé révoquée</Pill>
                    </span>
                  )}
                </GlassCard>
              ))}
            </div>
          )}
        </Section>

        <Section title="Capacités">
          <p className="mb-2 text-[12.5px] text-fg-3" data-testid="capabilities-count">
            {caps.length} capacité(s) au registre — statut réel, verdict d'évaluation, empreinte du contenu.
          </p>
          {caps.length === 0 ? (
            <EmptyGlass icon="capabilities" title="Registre vide" description="Le radar n'a encore rien évalué." />
          ) : (
            <div className="flex flex-col gap-2">
              {caps.map(capability => {
                const status = capability.status ?? 'inconnu'
                const state = capability.status ?? ''
                return (
                  <GlassCard key={capability.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5" data-testid={`cap-row-${capability.id}`}>
                    <strong className="min-w-[150px] text-[13px] font-semibold">{capability.name ?? capability.id}</strong>
                    <span className="font-mono text-[11.5px] text-fg-3">{capability.version ?? '—'}</span>
                    <span className="text-[12px] text-fg-3">{capability.type ?? '—'}</span>
                    <span data-status={status}>
                      <Pill tone={STATUS_TONE[status] ?? 'muted'}>{status.replace('_', ' ')}</Pill>
                    </span>
                    {capability.verdict && <Pill tone={capability.verdict === 'safe' ? 'ok' : capability.verdict === 'dangerous' ? 'danger' : 'warn'}>{capability.verdict}</Pill>}
                    <span className="font-mono text-[11px] text-fg-4">{capability.hash ? `${capability.hash.slice(0, 12)}…` : '—'}</span>
                    <span className="flex-1" />
                    <GlassButton size="sm" data-action="cap-evaluate" disabled={busy || !capability.source} title={capability.source ? undefined : 'aucune source connue'} onClick={() => void run('capability.evaluate', { path: capability.source, id: capability.id })}>
                      Évaluer
                    </GlassButton>
                    <GlassButton size="sm" data-action="cap-integrate" disabled={busy || !['detected', 'analyzed', 'proposed', 'approved', 'failed'].includes(state)} title="déjà intégrée" onClick={() => void run('capability.integrate', { id: capability.id, kind: capability.type ?? 'skill' })}>
                      Intégrer
                    </GlassButton>
                    <GlassButton size="sm" data-action="cap-enable" disabled={busy || state !== 'disabled'} title="seule une capacité désactivée s'active" onClick={() => void run('capability.set-active', { id: capability.id, active: true })}>
                      Activer
                    </GlassButton>
                    <GlassButton size="sm" data-action="cap-disable" disabled={busy || state !== 'active'} title="seule une capacité active se désactive" onClick={() => void run('capability.set-active', { id: capability.id, active: false })}>
                      Désactiver
                    </GlassButton>
                    <GlassButton size="sm" data-action="cap-rollback" disabled={busy || !['active', 'disabled'].includes(state)} title="aucune intégration à annuler" onClick={() => void run('capability.rollback', { id: capability.id })}>
                      Rollback
                    </GlassButton>
                    <GlassButton variant="danger" size="sm" data-action="cap-remove" disabled={busy || !['active', 'disabled', 'rolled_back', 'rejected', 'failed'].includes(state)} onClick={() => void run('capability.remove', { id: capability.id })}>
                      Supprimer
                    </GlassButton>
                  </GlassCard>
                )
              })}
            </div>
          )}
        </Section>

        <Section title="Dépendances d'exécution">
          <p className="mb-2 text-[12.5px] text-fg-3" data-testid="deps-count">
            {deps.length} composant(s) — versions installées, politique de mise à jour, risque et retour arrière.
          </p>
          <div className="flex flex-col gap-2">
            {deps.map(dep => {
              const state = depsState[dep.id] ?? {}
              const policy = state.policy ?? 'notify'
              return (
                <GlassCard key={dep.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5" data-testid={`dep-row-${dep.id}`}>
                  <strong className="min-w-[130px] text-[13px] font-semibold">{dep.name}</strong>
                  <span className="font-mono text-[11.5px] text-fg-3" data-role="version">{dep.version ?? (dep.installed ? '—' : 'absent')}</span>
                  <span data-policy={policy}><Pill tone={policy === 'manual' ? 'muted' : policy === 'notify' ? 'warn' : 'ok'}>{policy}</Pill></span>
                  <Pill tone={dep.critical ? 'warn' : 'muted'}>{dep.critical ? 'critique' : 'standard'}</Pill>
                  <span className="text-[11px] text-fg-4">{dep.installed ? `${dep.candidates.length} candidat(s)` : 'non installé'}</span>
                  <span className="flex-1" />
                  <GlassButton size="sm" data-action="dep-propose" disabled={busy} onClick={() => void verify(dep.id)}>Vérifier</GlassButton>
                  <GlassButton size="sm" data-action="dep-policy" disabled={busy} onClick={() => void run('deps.policy', { id: dep.id, policy: POLICY_CYCLE[(POLICY_CYCLE.indexOf(policy as (typeof POLICY_CYCLE)[number]) + 1) % POLICY_CYCLE.length] })}>
                    Politique
                  </GlassButton>
                  <GlassButton size="sm" data-action="dep-apply" disabled={busy || !['auto-safe', 'auto-full'].includes(policy)} title={`politique ${policy} : passer en auto-safe pour appliquer`} onClick={() => void run('deps.update', { id: dep.id, kind: 'portable' })}>
                    Appliquer
                  </GlassButton>
                  <GlassButton size="sm" data-action="dep-rollback" disabled={busy || !state.previous} title="aucune version précédente conservée" onClick={() => void run('deps.rollback', { id: dep.id })}>
                    Rollback
                  </GlassButton>
                </GlassCard>
              )
            })}
          </div>
        </Section>

        <Section title="Mises à jour disponibles">
          {proposals.length === 0 ? (
            <p className="text-[12.5px] text-fg-3" data-testid="updates-empty">
              Aucune proposition : utilisez « Vérifier » sur un composant. La version disponible n'est pas interrogée sur le réseau.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {proposals.map(proposal => (
                <GlassCard key={proposal.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5" data-testid={`update-row-${proposal.id}`}>
                  <strong className="min-w-[120px] text-[13px] font-semibold">{proposal.name}</strong>
                  <span className="font-mono text-[11.5px] text-fg-3">{proposal.current ?? '?'} → {proposal.available ?? 'inconnue'}</span>
                  <Pill tone={proposal.risk === 'critical' ? 'warn' : 'muted'}>{proposal.risk}</Pill>
                  <span className="text-[11.5px] text-fg-3">{proposal.updatePossible ? 'mise à jour possible' : 'rien à installer sans version disponible'}</span>
                  <span className="flex-1" />
                  <span className="text-[11px] text-fg-4">{proposal.recommendation}</span>
                </GlassCard>
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  )
}
