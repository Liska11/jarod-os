import { Icon } from './icons.tsx'
import { Button, Sheet } from './ui.tsx'

/**
 * Before the system asks: why Jarod wants the "Nearby devices" permission. Android 16 can restrict an
 * app's access to the local network, and the PC is on it. Said plainly, once; refusing is allowed.
 */
export function LocalNetworkSheet({ open, onAllow, onLater }: { open: boolean; onAllow: () => void; onLater: () => void }) {
  return (
    <Sheet open={open} onClose={onLater} title="Joindre votre PC sur le Wi-Fi" label="Autorisation du réseau local">
      <div className="explain">
        <span className="empty-mark">
          <Icon name="wifi" size={32} />
        </span>
        <p>
          Chez vous, Jarod parle à votre PC <b>directement par le Wi-Fi</b>, sans serveur intermédiaire. Android 16 peut bloquer cela tant que vous n’avez pas accordé <b>« Appareils à proximité »</b> à l’appli.
        </p>
        <ul>
          <li>Jarod n’utilise ni votre position ni la recherche d’appareils : il ne contacte que l’adresse de votre PC.</li>
          <li>Si vous refusez, rien ne casse : Tailscale reste utilisable, mais la connexion directe au Wi-Fi peut être coupée par Android.</li>
          <li>Vous pourrez changer d’avis dans Réglages › Diagnostic.</li>
        </ul>
        <div className="approval-actions">
          <Button tone="outlined" onClick={onLater}>
            Plus tard
          </Button>
          <Button tone="filled" feel="confirm" onClick={onAllow}>
            Continuer
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
