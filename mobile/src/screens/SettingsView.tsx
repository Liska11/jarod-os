import { useCallback, useEffect, useState } from 'react'
import { Button, Dialog, Group, ListItem, Segmented, Switch, TopBar, useBackLayer } from '../components/ui.tsx'
import type { Link } from '../App.tsx'
import type { JarodChannel } from '../lib/channel.ts'
import { type LinkMode, MODE_LABEL, shortAddress } from '../lib/diagnostics.ts'
import { accessibility, assist, isNative, notifications, type OrbState, system } from '../lib/native.ts'
import { TOPICS } from '../lib/news.ts'
import { toggled } from '../lib/notif-digest.ts'
import { allowNotifications } from '../lib/notify.ts'
import type { PairedPc } from '../lib/pairing-store.ts'
import { forget, setWatch } from '../lib/session.ts'
import { LOCK_CHOICES, type LockDelay } from '../lib/settings.ts'
import { setReadAloud, speechStatus, stopReading } from '../lib/speech.ts'
import type { MotionPref, ThemePref } from '../lib/theme.ts'
import { useAppearance } from '../state/appearance.tsx'
import type { Workspace } from '../state/useWorkspace.ts'
import { DiagnosticView } from './DiagnosticView.tsx'

export type SettingsPage = 'connection' | 'security' | 'voice' | 'assistant' | 'notifications' | 'appearance' | 'diagnostic' | 'about'

interface Props {
  page: SettingsPage | null
  onPage: (p: SettingsPage | null) => void
  ws: Workspace
  pc: PairedPc
  channel: JarodChannel | null
  link: Link
  mode: LinkMode
  lockDelay: LockDelay
  onLockDelay: (d: LockDelay) => void
  onLock: () => void
  onPcChanged: (pc: PairedPc) => void
  onForgotten: () => void
}

const TITLE: Record<SettingsPage, string> = {
  connection: 'Connexion',
  security: 'Sécurité',
  voice: 'Voix',
  assistant: 'Assistant',
  notifications: 'Notifications',
  appearance: 'Apparence',
  diagnostic: 'Diagnostic',
  about: 'À propos'
}

export function SettingsView(p: Props) {
  // The back gesture goes up one level, from a sub-page to the list.
  useBackLayer(p.page !== null, () => p.onPage(null))
  if (p.page === 'diagnostic') return <DiagnosticView pc={p.pc} channel={p.channel} link={p.link} mode={p.mode} onBack={() => p.onPage(null)} />
  if (p.page === null) return <SettingsHome {...p} />
  return (
    <div className="view">
      <TopBar title={TITLE[p.page]} onBack={() => p.onPage(null)} />
      <div className="scroll pad">
        {p.page === 'connection' && <Connection {...p} />}
        {p.page === 'security' && <Security {...p} />}
        {p.page === 'voice' && <Voice {...p} />}
        {p.page === 'assistant' && <Assistant />}
        {p.page === 'notifications' && <Notifications {...p} />}
        {p.page === 'appearance' && <Appearance />}
        {p.page === 'about' && <About {...p} />}
      </div>
    </div>
  )
}

function SettingsHome({ pc, mode, link, onPage }: Props) {
  const status = link === 'online' ? MODE_LABEL[mode] : link === 'connecting' ? 'Connexion…' : 'Hors ligne'
  return (
    <div className="view">
      <TopBar title="Réglages" sub={`${pc.name} · ${status}`} />
      <div className="scroll pad">
        <Group>
          <ListItem icon="link" title="Connexion" hint="PC associé, adresses, veille" onClick={() => onPage('connection')} end={<Chevron />} />
          <ListItem icon="shield" title="Sécurité" hint="Verrouillage automatique" onClick={() => onPage('security')} end={<Chevron />} />
          <ListItem icon="volume" title="Voix" hint="Lecture des réponses" onClick={() => onPage('voice')} end={<Chevron />} />
          <ListItem icon="mic" title="Assistant" hint="Appeler Jarod depuis n’importe quelle appli" onClick={() => onPage('assistant')} end={<Chevron />} />
          <ListItem icon="bell" title="Notifications" hint="Par type de nouvelle" onClick={() => onPage('notifications')} end={<Chevron />} />
          <ListItem icon="contrast" title="Apparence" hint="Thème, couleurs, animations" onClick={() => onPage('appearance')} end={<Chevron />} />
        </Group>
        <Group>
          <ListItem icon="speed" title="Diagnostic" hint="Adresse, latence, veille, batterie" onClick={() => onPage('diagnostic')} end={<Chevron />} />
          <ListItem icon="info" title="À propos" hint="Version et confidentialité" onClick={() => onPage('about')} end={<Chevron />} />
        </Group>
      </div>
    </div>
  )
}

const Chevron = () => (
  <svg className="icon" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
  </svg>
)

function Connection({ pc, channel, ws, onPcChanged, onForgotten }: Props) {
  const [forgetting, setForgetting] = useState(false)
  return (
    <>
      <Group title="PC associé">
        <ListItem icon="link" title={pc.name} hint={`Associé le ${new Date(pc.pairedAt).toLocaleDateString()} sous le nom « ${pc.deviceName} »`} />
        <ListItem icon="wifi" title="Adresses" hint={pc.urls.map(shortAddress).join(' · ') || 'Aucune'} />
      </Group>
      <Group title="Appli fermée">
        <Switch
          icon="bell"
          checked={pc.watch}
          title="Veille quand l’appli est fermée"
          hint="Le téléphone demande au PC « du nouveau ? », sans jamais recevoir le contenu. Notification permanente « Jarod veille »."
          onChange={async on => {
            if (on && !(await allowNotifications())) return ws.setError('Notifications refusées : autorisez-les dans les réglages du téléphone.')
            await setWatch(pc, channel, on).catch(err => ws.setError((err as Error).message))
            onPcChanged({ ...pc, watch: on })
          }}
        />
      </Group>
      <Group>
        <ListItem
          icon="trash"
          danger
          title="Oublier ce PC"
          hint="Le PC retire ce téléphone de sa liste ; il faudra l’associer à nouveau."
          onClick={() => setForgetting(true)}
        />
      </Group>
      <Dialog
        open={forgetting}
        onClose={() => setForgetting(false)}
        title={`Oublier ${pc.name} ?`}
        actions={
          <>
            <Button tone="text" onClick={() => setForgetting(false)}>
              Annuler
            </Button>
            <Button
              tone="danger"
              feel="warn"
              onClick={async () => {
                await forget(channel)
                onForgotten()
              }}
            >
              Oublier ce PC
            </Button>
          </>
        }
      >
        <p>Le PC retirera ce téléphone de sa liste, et la clé de ce téléphone sera effacée. Il faudra une nouvelle association avec un code.</p>
      </Dialog>
    </>
  )
}

function Security({ lockDelay, onLockDelay, onLock }: Props) {
  return (
    <>
      <Group title="Verrouillage automatique" note="Après cette absence, l’appli se verrouille : la clé de ce téléphone quitte la mémoire et il faut l’empreinte, le visage ou le code pour la rouvrir.">
        <div className="group-pad">
          <Segmented
            label="Délai de verrouillage"
            value={lockDelay}
            options={LOCK_CHOICES.map(c => ({ value: c.ms, label: c.label === 'Jamais' ? 'Jamais' : c.label.replace(' minutes', ' min').replace(' minute', ' min') }))}
            onChange={onLockDelay}
          />
          {lockDelay === 0 && <p className="warn-note">Sans verrouillage, la clé reste ouverte tant que l’appli vit en arrière-plan.</p>}
        </div>
      </Group>
      <Group note="Les accords continuent de demander l’empreinte, le visage ou le code, à chaque fois.">
        <ListItem icon="lock" title="Verrouiller maintenant" onClick={onLock} />
      </Group>
    </>
  )
}

function Voice({ ws }: Props) {
  return (
    <Group>
      <Switch
        icon="volume"
        checked={ws.speak}
        title="Lire les réponses à voix haute"
        hint="Avec la synthèse vocale du téléphone et ses voix installées : rien ne part sur Internet."
        onChange={async on => {
          if (on) {
            const st = await speechStatus()
            if (!st.available) return ws.setError(st.reason ?? 'Lecture à voix haute indisponible sur ce téléphone.')
          } else void stopReading()
          setReadAloud(on)
          ws.setSpeak(on)
        }}
      />
    </Group>
  )
}

/** Runs `refresh` now and each time the app comes back (from a system settings screen, say). */
function useRefreshOnFocus(refresh: () => void) {
  useEffect(() => {
    refresh()
    document.addEventListener('visibilitychange', refresh)
    return () => document.removeEventListener('visibilitychange', refresh)
  }, [refresh])
}

function Assistant() {
  const [orb, setOrb] = useState<OrbState | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(() => void assist.orb().then(setOrb).catch(() => {}), [])
  useRefreshOnFocus(refresh)

  const toggle = async (on: boolean) => {
    setBusy(true)
    try {
      if (!on) return setOrb(await assist.orbStop())
      const next = await assist.orbStart()
      setOrb(next)
      // Not allowed yet: the system's own screen asks, then the owner switches the bubble on again.
      if (!next.allowed) void system.openSettings({ target: 'overlay' })
    } catch {
      refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Group
        title="Assistant du téléphone"
        note="Une fois Jarod choisi comme « appli d’assistance numérique », le geste d’assistance du système (maintenir le bouton d’accueil, balayer depuis un coin) ouvre le chat par-dessus l’appli en cours. Rien de ce qui est à l’écran n’est lu ni envoyé au PC. Il faut l’empreinte, le visage ou le code à chaque ouverture."
      >
        <ListItem icon="mic" title="Choisir l’assistant du système" hint="Applis par défaut, Appli d’assistance numérique" onClick={() => void system.openSettings({ target: 'assistant' })} />
      </Group>
      {isNative && (
        <Group
          title="Bulle flottante"
          note={
            orb && !orb.allowed
              ? 'Android demande d’abord d’autoriser « Afficher par-dessus les autres applis ». Autorisez-le, revenez ici, puis rallumez la bulle.'
              : 'Une bulle que l’on déplace sur les bords de l’écran ; la toucher ouvre l’assistant. Elle ne lit rien et n’envoie rien. Elle s’éteint au redémarrage du téléphone.'
          }
        >
          <Switch checked={Boolean(orb?.running)} title="Afficher la bulle" hint="Par-dessus toutes les applis" onChange={on => !busy && void toggle(on)} />
        </Group>
      )}
      {isNative && <NotificationReader />}
      {isNative && <ScreenReader />}
    </>
  )
}

/** "Mes notifications": the apps whose showing notifications the owner may attach to a message. */
function NotificationReader() {
  const [state, setState] = useState<{ enabled: boolean; connected: boolean; allowed: string[] } | null>(null)
  const [apps, setApps] = useState<{ pkg: string; label: string }[]>([])
  const refresh = useCallback(() => {
    void notifications.status().then(setState).catch(() => {})
    void notifications.apps().then(r => setApps(r.apps)).catch(() => {})
  }, [])
  useRefreshOnFocus(refresh)

  const tick = (pkg: string, on: boolean) => {
    if (!state) return
    const allowed = toggled(state.allowed, pkg, on)
    setState({ ...state, allowed })
    void notifications.setAllowed({ packages: allowed }).catch(refresh)
  }

  return (
    <>
      <Group
        title="Lecture des notifications"
        note="Jarod ne lit une notification que si vous l’avez autorisé ici ET dans le système, appli par appli. Rien n’est enregistré ni envoyé tout seul : dans le chat, « Mes notifications » ajoute un brouillon que vous relisez, modifiez et envoyez vous-même. Si Android refuse l’accès, ouvrez Infos de l’appli puis « Autoriser les paramètres restreints »."
      >
        <ListItem icon="bell" title={state?.enabled ? 'Accès autorisé dans le système' : 'Autoriser l’accès aux notifications'} hint="Réglages Android, Accès aux notifications" onClick={() => void system.openSettings({ target: 'listener' })} />
      </Group>
      {state?.enabled && (
        <Group title="Applis lues" note={apps.length ? 'Les applis qui ont une notification affichée en ce moment apparaissent ici.' : 'Aucune notification affichée pour l’instant : revenez quand l’appli voulue en a une.'}>
          {apps.map(a => (
            <Switch key={a.pkg} checked={state.allowed.includes(a.pkg)} title={a.label} hint={a.pkg} onChange={on => tick(a.pkg, on)} />
          ))}
        </Group>
      )}
    </>
  )
}

/**
 * "Lire l'écran": off until the owner has read what it does, here, and switched it on in Android's
 * Accessibility settings. The explanation comes first, in the app, because the system's own screen
 * lists only the permission, not what Jarod does with it.
 */
function ScreenReader() {
  const [state, setState] = useState<{ enabled: boolean; connected: boolean; screenshot: boolean } | null>(null)
  const [asking, setAsking] = useState(false)
  const refresh = useCallback(() => void accessibility.status().then(setState).catch(() => {}), [])
  useRefreshOnFocus(refresh)

  return (
    <>
      <Group
        title="Lecture de l’écran"
        note="Dans l’assistant, « Texte de l’écran » et « Capture de l’écran » montrent à Jarod l’appli ouverte derrière. Chaque fois : votre empreinte, votre visage ou votre code. Jarod ne touche, ne tape et ne glisse jamais à votre place, ne lit pas les champs de mot de passe, ne garde rien, et ne reçoit que ce que vous envoyez."
      >
        <ListItem
          icon="shield"
          title={state?.enabled ? 'Accès à l’écran activé' : 'Activer l’accès à l’écran'}
          hint={state?.enabled ? 'Réglages Android, Accessibilité (pour le retirer)' : 'Réglages Android, Accessibilité'}
          onClick={() => (state?.enabled ? void system.openSettings({ target: 'accessibility' }) : setAsking(true))}
        />
      </Group>
      <Dialog
        open={asking}
        onClose={() => setAsking(false)}
        title="Lire l’écran à votre demande ?"
        actions={
          <>
            <Button tone="text" onClick={() => setAsking(false)}>
              Annuler
            </Button>
            <Button
              tone="text"
              onClick={() => {
                setAsking(false)
                void system.openSettings({ target: 'accessibility' })
              }}
            >
              Continuer
            </Button>
          </>
        }
      >
        <p>
          Android va ouvrir ses réglages d’accessibilité : choisissez « Jarod, lecture de l’écran » et activez-le. Il pourra alors lire le texte de l’appli affichée, ou la capturer, seulement quand vous le demandez dans l’assistant et après votre empreinte. Il ne peut ni toucher ni taper à votre place. Vous pouvez le retirer à tout moment au même endroit.
        </p>
      </Dialog>
    </>
  )
}

function Notifications({ ws }: Props) {
  return (
    <>
      <Group title="Par type" note="Choix gardés sur ce téléphone. Appli fermée, la veille ne sait pas de quoi il s’agit : elle se tait seulement si tout est décoché.">
        {TOPICS.map(t => (
          <Switch key={t.topic} checked={ws.prefs[t.topic]} title={t.label} hint={t.hint} onChange={on => void ws.choose(t.topic, on)} />
        ))}
      </Group>
      <Group>
        <ListItem icon="settings" title="Notifications du système" hint="Son, bannière, écran verrouillé" onClick={() => void system.openSettings({ target: 'notifications' })} />
      </Group>
    </>
  )
}

function Appearance() {
  const { appearance, setAppearance, dynamicSupported, haptics, setHaptics } = useAppearance()
  return (
    <>
      <Group title="Thème">
        <div className="group-pad">
          <Segmented<ThemePref>
            label="Thème"
            value={appearance.theme}
            options={[
              { value: 'system', label: 'Système' },
              { value: 'light', label: 'Clair' },
              { value: 'dark', label: 'Sombre' }
            ]}
            onChange={theme => setAppearance({ ...appearance, theme })}
          />
        </div>
        <Switch
          icon="contrast"
          checked={appearance.dynamic && dynamicSupported}
          disabled={!dynamicSupported}
          title="Couleurs du fond d’écran"
          hint={dynamicSupported ? 'Les couleurs de l’appli suivent votre fond d’écran (Android 12 et plus).' : 'Disponible à partir d’Android 12 : la palette fixe est utilisée ici.'}
          onChange={dynamic => setAppearance({ ...appearance, dynamic })}
        />
      </Group>
      <Group title="Animations" note="« Réduites » supprime les mouvements : la bulle du mode Live ne bouge plus, seules les couleurs changent.">
        <div className="group-pad">
          <Segmented<MotionPref>
            label="Animations"
            value={appearance.motion}
            options={[
              { value: 'system', label: 'Système' },
              { value: 'reduced', label: 'Réduites' },
              { value: 'full', label: 'Complètes' }
            ]}
            onChange={motion => setAppearance({ ...appearance, motion })}
          />
        </div>
      </Group>
      <Group>
        <Switch icon="tool" checked={haptics} title="Retour haptique" hint="Une courte vibration pour envoyer, décider ou copier." onChange={setHaptics} />
      </Group>
    </>
  )
}

function About({ pc, mode }: Props) {
  return (
    <>
      <Group title="Jarod pour Android">
        <ListItem icon="info" title="Version" hint={`${__APP_VERSION__}`} />
        <ListItem icon="link" title="PC" hint={`${pc.name} · ${MODE_LABEL[mode]}`} />
      </Group>
      <Group title="Confidentialité" note="La clé de ce téléphone est protégée par le Keystore d’Android et ne sort jamais en clair. Aucun service de notification (Google ou autre) n’est utilisé.">
        <ListItem icon="shield" title="Canal chiffré de bout en bout" hint="Entre ce téléphone et votre PC, par le Wi-Fi ou Tailscale. Rien ne passe par un serveur tiers." />
      </Group>
    </>
  )
}
