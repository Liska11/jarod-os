import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { writeFileAtomic } from './atomic-write.ts'

/*
 * La clé du dépôt restic (G4, raccordé à Réglages › Stockage le 2026-10-21). Elle est rangée CHIFFRÉE par Windows : `safeStorage` d'Electron,
 * c'est-à-dire DPAPI pour l'utilisateur de cette session (via la clé de « Local State » du profil Electron). Conséquences, dites à l'écran :
 *  - elle n'est lisible que par ce compte Windows, sur ce PC, avec ce profil d'application ;
 *  - elle vit dans le dossier de configuration, dont la sauvegarde externe ne copie que `prefs.json` : elle n'est JAMAIS dans une sauvegarde ;
 *  - perdre le PC ou le profil, c'est perdre la clé : d'où la FEUILLE DE RÉCUPÉRATION, écrite à part par l'utilisateur.
 * La valeur ne quitte jamais le processus principal (ni la fenêtre, ni le journal) ; seule son empreinte courte est montrée.
 */

export interface KeyCipher {
  available(): boolean
  encrypt(plain: string): Buffer
  decrypt(blob: Buffer): string
}

export class ResticKeyStore {
  constructor(
    private readonly file: string,
    private readonly cipher: KeyCipher
  ) {}

  has(): boolean {
    return fs.existsSync(this.file)
  }

  /** La clé déchiffrée ; lève si le fichier manque ou ne se déchiffre pas (autre compte, autre profil). */
  read(): string {
    if (!this.cipher.available()) throw new Error('no-dpapi')

    return this.cipher.decrypt(fs.readFileSync(this.file))
  }

  write(key: string): void {
    if (!this.cipher.available()) throw new Error('no-dpapi')
    writeFileAtomic(this.file, this.cipher.encrypt(key))
  }

  /** Huit caractères pour reconnaître la clé sur la feuille sans la montrer. */
  static fingerprint(key: string): string {
    return createHash('sha256').update(key).digest('hex').slice(0, 8)
  }
}
