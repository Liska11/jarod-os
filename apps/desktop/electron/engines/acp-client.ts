import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

/*
 * Client ACP (Agent Client Protocol, https://agentclientprotocol.com) : JSON-RPC 2.0, un message par ligne, sur les tuyaux
 * d'un processus que Jarod possède. Aucun réseau : la seule « authentification » est d'être le parent du processus.
 * Il ne connaît que le transport ; ce que disent les messages est l'affaire de `acp-translate.ts` et du moteur.
 */

/** La seule version du protocole que Jarod parle (ACP v1, vérifiée sur DSH 0.2.0-rc.2 et 0.2.1-rc.2). */
export const ACP_PROTOCOL_VERSION = 1

export class AcpError extends Error {
  constructor(
    message: string,
    readonly code?: number
  ) {
    super(message)
  }
}

export interface AcpNotification {
  method: string
  params: Record<string, unknown>
}

/** Une question du moteur à Jarod (`session/request_permission`…) : rendre un résultat, ou lever pour répondre une erreur. */
export type AcpRequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  method: string
}

export class AcpConnection {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<(notification: AcpNotification) => void>()
  private handler: AcpRequestHandler = async method => {
    throw new AcpError(`méthode non prise en charge par Jarod : ${method}`, -32601)
  }
  private closed = false
  /** Lignes que le moteur a écrites sur stdout sans être du protocole (un plugin bavard) : comptées, jamais interprétées. */
  strayLines = 0

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly timeoutMs = 120_000
  ) {
    const lines = createInterface({ input })
    lines.on('line', line => this.receive(line))
    lines.on('close', () => this.close(new AcpError('le moteur a fermé sa sortie')))
  }

  onNotification(listener: (notification: AcpNotification) => void): () => void {
    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }

  onRequest(handler: AcpRequestHandler): void {
    this.handler = handler
  }

  request<T>(method: string, params: Record<string, unknown>, timeoutMs = this.timeoutMs): Promise<T> {
    if (this.closed) {
      return Promise.reject(new AcpError('connexion ACP fermée'))
    }

    const id = this.nextId++

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new AcpError(`${method} : pas de réponse en ${Math.round(timeoutMs / 1000)} s`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer,
        method
      })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (!this.closed) {
      this.send({ jsonrpc: '2.0', method, params })
    }
  }

  /** Rejette tout ce qui attend : appelé quand le processus s'arrête. */
  close(reason: Error = new AcpError('connexion ACP fermée')): void {
    if (this.closed) {
      return
    }

    this.closed = true

    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(reason)
      this.pending.delete(id)
    }
  }

  get isClosed(): boolean {
    return this.closed
  }

  private send(message: object): void {
    this.output.write(`${JSON.stringify(message)}\n`)
  }

  private receive(line: string): void {
    let message: {
      id?: unknown
      method?: unknown
      params?: unknown
      result?: unknown
      error?: { code?: number; message?: string }
    }

    try {
      message = JSON.parse(line)
    } catch {
      this.strayLines++

      return
    }

    if (!message || typeof message !== 'object') {
      this.strayLines++

      return
    }

    const params = (message.params && typeof message.params === 'object' ? message.params : {}) as Record<string, unknown>

    if (typeof message.method === 'string' && message.id !== undefined) {
      const id = message.id
      void this.handler(message.method, params).then(
        result => this.send({ jsonrpc: '2.0', id, result: result ?? null }),
        (error: unknown) =>
          this.send({
            jsonrpc: '2.0',
            id,
            error: {
              code: error instanceof AcpError && error.code ? error.code : -32603,
              message: error instanceof Error ? error.message : String(error)
            }
          })
      )

      return
    }

    if (typeof message.method === 'string') {
      for (const listener of this.listeners) {
        listener({ method: message.method, params })
      }

      return
    }

    const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined

    if (!pending) {
      return
    }

    clearTimeout(pending.timer)
    this.pending.delete(message.id as number)

    if (message.error) {
      pending.reject(new AcpError(`${pending.method} : ${message.error.message ?? 'erreur'}`, message.error.code))
    } else {
      pending.resolve(message.result)
    }
  }
}
