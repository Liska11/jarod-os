import { useCallback, useEffect, useState } from 'react'
import { Icon } from '../components/icons.tsx'
import { Button, Group, ListItem, TopBar } from '../components/ui.tsx'
import type { JarodChannel } from '../lib/channel.ts'
import {
  batteryChecklist,
  formatLatency,
  isOnePlus,
  isTailnetHost,
  type LinkMode,
  MODE_LABEL,
  measureLatency,
  type PowerState,
  shortAddress
} from '../lib/diagnostics.ts'
import { describeLocalNet, type LocalNetState, loadRefused, noteAnswer, saveExplained } from '../lib/localnet.ts'
import { system, wake } from '../lib/native.ts'
import type { PairedPc } from '../lib/pairing-store.ts'
import type { Link } from '../App.tsx'

interface Props {
  pc: PairedPc
  channel: JarodChannel | null
  link: Link
  mode: LinkMode
  onBack: () => void
}

const STATE_LABEL = { ok: 'En ordre', todo: 'À régler', unknown: 'À vérifier' } as const
const LINK_LABEL: Record<Link, string> = { online: 'Canal ouvert', connecting: 'Connexion en cours…', offline: 'Canal fermé' }

/**
 * What the phone knows about its way to the PC and about what could stop the watch while the app is
 * closed. The checklist ticks only what an app is allowed to read; the rest is a reminder with a shortcut.
 */
export function DiagnosticView({ pc, channel, link, mode, onBack }: Props) {
  const [latency, setLatency] = useState<number | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [watching, setWatching] = useState<boolean | null>(null)
  const [power, setPower] = useState<PowerState | null>(null)
  const [opened, setOpened] = useState('')
  const [localNet, setLocalNet] = useState<LocalNetState>('unneeded')
  const [refused, setRefused] = useState(loadRefused)
  const net = describeLocalNet(localNet, refused)

  const measure = useCallback(async () => {
    if (!channel) return setLatency(null)
    setMeasuring(true)
    // Two rounds: the first one pays for the first packet, the second is the usual delay.
    await measureLatency(() => channel.rpc('sessions.list', undefined, 8000))
    setLatency(await measureLatency(() => channel.rpc('sessions.list', undefined, 8000)))
    setMeasuring(false)
  }, [channel])

  const refresh = useCallback(() => {
    void wake
      .status()
      .then(s => setWatching(s.running))
      .catch(() => setWatching(null))
    void system
      .power()
      .then(setPower)
      .catch(() => setPower(null))
    void system
      .localNetwork()
      .then(r => setLocalNet(r.state))
      .catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    void measure()
    // Back from the system settings: what was changed there shows at once.
    const onVisible = () => !document.hidden && refresh()
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [measure, refresh])

  const checks = batteryChecklist(power)
  // Unknown is neither good nor bad: no colour (the grey default).
  const tone = (s: 'ok' | 'todo' | 'unknown') => (s === 'ok' ? 'ok' : s === 'todo' ? 'warn' : '')

  return (
    <div className="view">
      <TopBar title="Diagnostic" sub="Connexion et veille" onBack={onBack} />
      <div className="scroll pad">
        <Group title="Connexion au PC">
          <ListItem icon="link" title="Canal chiffré" hint={LINK_LABEL[link]} />
          <ListItem icon="wifi" title="Mode" hint={MODE_LABEL[mode]} end={<span className={`pill ${mode === 'offline' ? 'off' : 'ok'}`}>{mode === 'offline' ? 'Hors ligne' : 'Actif'}</span>} />
          <ListItem icon="link" title="Adresse retenue" hint={channel?.base ? shortAddress(channel.base) : pc.lastUrl ? `${shortAddress(pc.lastUrl)} (dernière connue)` : 'Aucune'} />
          <ListItem icon="speed" title="Latence" hint="Un aller-retour avec le PC" end={<b>{measuring ? '…' : formatLatency(latency)}</b>} />
          <div className="group-actions">
            <Button tone="tonal" disabled={!channel || measuring} onClick={() => void measure()} feel="tap">
              Mesurer à nouveau
            </Button>
          </div>
        </Group>

        <Group title="Adresses du PC" note="Le téléphone les essaie toutes ; la première qui répond est gardée. Elles sont fixées à l’association : si l’IP du PC change, associez-le à nouveau.">
          {pc.urls.map(u => {
            const host = new URL(u).hostname
            const won = channel?.base === u
            return <ListItem key={u} icon={won ? 'check' : 'wifi'} title={shortAddress(u)} hint={isTailnetHost(host) ? 'Tailscale' : 'Réseau local'} end={won ? <span className="pill ok">Retenue</span> : undefined} />
          })}
        </Group>

        <Group title="Réseau local (Android 16)" note="Sans cette autorisation, Android 16 peut couper la connexion directe par le Wi-Fi. Tailscale n’en dépend pas.">
          <div className="check">
            <div className="check-head">
              <span className={`dot ${net.tone === 'ok' ? 'ok' : net.tone === 'warn' ? 'warn' : ''}`} aria-hidden="true" />
              <b>{net.title}</b>
              <span className={`pill ${net.tone === 'ok' ? 'ok' : net.tone === 'warn' ? 'warn' : ''}`}>{localNet === 'granted' ? 'Autorisé' : localNet === 'unneeded' ? 'Sans objet' : net.tone === 'warn' ? 'Refusé' : 'À donner'}</span>
            </div>
            <p>{net.text}</p>
            {net.actions.includes('ask') && (
              <Button
                tone="tonal"
                feel="tap"
                onClick={async () => {
                  saveExplained()
                  const { state } = await system.requestLocalNetwork().catch(() => ({ state: localNet }))
                  noteAnswer(state)
                  setRefused(loadRefused())
                  setLocalNet(state)
                }}
              >
                {refused ? 'Réessayer' : 'Autoriser'}
              </Button>
            )}
            {net.actions.includes('settings') && (
              <Button tone="text" icon="settings" feel="tap" onClick={() => void system.openSettings({ target: 'app' })}>
                Ouvrir les réglages de l’appli
              </Button>
            )}
          </div>
        </Group>

        <Group title="Veille appli fermée" note="La veille est un service qui interroge le PC, par le Wi-Fi ou Tailscale. Elle ne reçoit jamais le contenu.">
          <ListItem
            icon="bell"
            title="Service de veille"
            hint={watching === null ? 'État inconnu' : watching ? 'En marche (notification « Jarod veille »)' : pc.watch ? 'Arrêté, alors qu’il devrait tourner' : 'Désactivé dans les réglages'}
            end={<span className={`pill ${watching ? 'ok' : pc.watch ? 'warn' : 'off'}`}>{watching ? 'Actif' : pc.watch ? 'À relancer' : 'Éteint'}</span>}
          />
        </Group>

        <Group
          title={isOnePlus(power) ? 'Batterie OnePlus' : 'Batterie'}
          note={
            power
              ? `${power.manufacturer} ${power.model} · Android SDK ${power.sdk}. Android ne laisse lire que deux de ces réglages ; les autres sont des rappels avec raccourci.`
              : 'Réglages indisponibles hors de l’appli Android.'
          }
        >
          {checks.map(c => (
            <div key={c.id} className="check">
              <div className="check-head">
                <span className={`dot ${tone(c.state)}`} aria-hidden="true" />
                <b>{c.title}</b>
                <span className={`pill ${tone(c.state)}`}>{STATE_LABEL[c.state]}</span>
              </div>
              <p>{c.help}</p>
              <Button
                tone="text"
                icon="settings"
                feel="tap"
                onClick={async () => {
                  const r = await system.openSettings({ target: c.target }).catch(() => ({ opened: false, via: '' }))
                  setOpened(r.opened ? (r.via === 'app' ? 'Cet écran n’existe pas sur ce téléphone : la page de l’appli s’est ouverte.' : '') : 'Impossible d’ouvrir les réglages.')
                }}
              >
                Ouvrir le réglage
              </Button>
            </div>
          ))}
          {opened && <p className="snack">{opened}</p>}
        </Group>
        <p className="group-note">
          <Icon name="info" size={14} /> Après un changement dans les réglages du téléphone, revenez ici : l’état se met à jour.
        </p>
      </div>
    </div>
  )
}
