/**
 * Photos and files sent to Jarod. The PC checks everything again (type, signature, size); these
 * checks only spare the phone a useless upload.
 */

/** Same limit as the PC (`MAX_REMOTE_FILE_BYTES` in remote-host.ts). */
export const MAX_FILE_BYTES = 4 * 1024 * 1024
/** A camera photo is shrunk to this many pixels on its long side before it is sent. */
const PHOTO_EDGE = 2048

/** The types the PC accepts, by extension when the picker gives no type. */
const BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json'
}
const ACCEPTED = new Set(Object.values(BY_EXTENSION))

/** For the file picker's `accept`. */
export const ACCEPT = [...ACCEPTED, ...Object.keys(BY_EXTENSION).map(e => `.${e}`)].join(',')

export interface Outgoing {
  name: string
  mime: string
  size: number
  /** Base64, as the RPC carries it. */
  data: string
}

/** The type to announce for a picked file, or an error to show. */
export function checkPick(name: string, type: string, size: number): { mime: string } | { error: string } {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  const mime = ACCEPTED.has(type) ? type : (BY_EXTENSION[ext] ?? '')
  if (!mime) return { error: 'Type de fichier non pris en charge : images, PDF ou texte seulement.' }
  if (size === 0) return { error: 'Fichier vide.' }
  if (size > MAX_FILE_BYTES && !mime.startsWith('image/')) return { error: 'Fichier trop volumineux (4 Mo au plus).' }
  return { mime }
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** A large photo (JPEG, PNG, WebP) re-encoded as a JPEG of at most PHOTO_EDGE pixels. */
async function shrink(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, PHOTO_EDGE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return new Promise((done, fail) => canvas.toBlob(b => (b ? done(b) : fail(new Error('Photo illisible.'))), 'image/jpeg', 0.85))
}

/** Reads a picked file into what `chat.file` sends, shrinking photos; throws a message to show. */
export async function prepare(file: File): Promise<Outgoing> {
  const checked = checkPick(file.name, file.type, file.size)
  if ('error' in checked) throw new Error(checked.error)
  let { mime } = checked
  let name = file.name || 'photo.jpg'
  let blob: Blob = file
  // Animated GIFs keep their frames; other images are shrunk when they are big.
  if (mime !== 'image/gif' && mime.startsWith('image/') && file.size > 1024 * 1024) {
    blob = await shrink(file)
    mime = 'image/jpeg'
    name = name.replace(/\.[a-z0-9]+$/i, '') + '.jpg'
  }
  if (blob.size > MAX_FILE_BYTES) throw new Error('Fichier trop volumineux (4 Mo au plus).')
  return { name, mime, size: blob.size, data: toBase64(new Uint8Array(await blob.arrayBuffer())) }
}

/** "1,2 Mo", "340 Ko". */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`
  return `${Math.max(1, Math.round(bytes / 1024))} Ko`
}
