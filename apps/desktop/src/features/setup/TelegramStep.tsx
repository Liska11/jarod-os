import { IconBrandTelegram, IconCheck } from '@tabler/icons-react'
import { useState } from 'react'
import type { TelegramBot, TelegramErrorCode, TelegramRoundTrip } from '../../../shared/ipc.ts'
import { GlassButton } from '../../components/ui/glass.tsx'
import { Spinner } from '../../components/ui/primitives.tsx'
import { type MessageKey, t } from '../../lib/i18n.ts'
import { jarod } from '../../lib/jarod.ts'
import { Footer, Heading } from './parts.tsx'

/**
 * First-run Telegram bot: the token from @BotFather is checked with Telegram (`getMe`), then a round trip (the person
 * writes to the bot, Jarod-OS answers), and only then saved in the engine's encrypted store and the channel started.
 * The bot's name is the one Telegram reports; the field is only a reminder of which bot this is.
 */
/** A failed check in the interface language; Telegram's own words when it gave a reason we have no text for. */
export function telegramError(result: { error?: string; code?: TelegramErrorCode }): string {
  if (!result.code) return result.error ?? t('setup.telegram.refused')
  const text = t(`setup.telegram.error.${result.code}` as MessageKey)
  return result.code === 'refused' || result.code === 'network' ? `${text} (${result.error ?? ''})` : text
}

export function TelegramStep({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [token, setToken] = useState('')
  const [bot, setBot] = useState<TelegramBot | null>(null)
  const [trip, setTrip] = useState<TelegramRoundTrip | null>(null)
  const [busy, setBusy] = useState<'check' | 'test' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const checked = bot?.ok === true

  const check = async () => {
    setBusy('check')
    setError(null)
    setTrip(null)
    try {
      const result = await window.heraldOS.setup.telegramCheck(token)
      setBot(result)
      if (!result.ok) setError(telegramError(result))
    } finally {
      setBusy(null)
    }
  }

  const test = async () => {
    setBusy('test')
    setError(null)
    try {
      const result = await window.heraldOS.setup.telegramTest(token, t('setup.telegram.reply'))
      setTrip(result)
      if (!result.ok) setError(telegramError(result))
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    setBusy('save')
    setError(null)
    try {
      await jarod('update-messaging-platform', 'telegram', { env: { TELEGRAM_BOT_TOKEN: token.trim() }, enabled: true })
      await jarod('start-gateway').catch(() => undefined)
      onDone()
    } catch (failure) {
      setError(t('setup.telegram.saveFailed', { error: (failure as Error).message }))
    } finally {
      setBusy(null)
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={event => {
        event.preventDefault()
        if (!checked) void check()
      }}
    >
      <Heading icon={<IconBrandTelegram size={18} />} title={t('setup.telegram.title')} text={t('setup.telegram.text')} />
      <label className="flex flex-col gap-1.5 text-[12px] text-fg-3">
        {t('setup.telegram.name')}
        <input value={name} onChange={event => setName(event.target.value)} placeholder="Jarod" className="glass-input h-10 rounded-lg px-3 text-[14px] text-fg outline-none" />
      </label>
      <label className="flex flex-col gap-1.5 text-[12px] text-fg-3">
        {t('setup.telegram.token')}
        <input
          type="password"
          value={token}
          onChange={event => {
            setToken(event.target.value)
            setBot(null)
            setTrip(null)
          }}
          autoComplete="off"
          spellCheck={false}
          placeholder="123456789:AA…"
          className="glass-input h-10 rounded-lg px-3 font-mono text-[13px] text-fg outline-none"
        />
      </label>

      {checked && (
        <div className="glass-input flex flex-col gap-2 rounded-lg px-3 py-2 text-[12.5px] text-fg-2">
          <span className="flex items-center gap-2 text-fg">
            <IconCheck size={15} className="text-ok" />
            {t('setup.telegram.found', { bot: bot?.username ? `@${bot.username}` : (bot?.name ?? '') })}
          </span>
          {name.trim() && bot?.name && name.trim() !== bot.name && <span className="text-fg-3">{t('setup.telegram.otherName', { name: bot.name })}</span>}
          {trip?.ok ? (
            <span className="flex items-center gap-2 text-fg">
              <IconCheck size={15} className="text-ok" />
              {t('setup.telegram.tested', { from: trip.from ?? '' })}
            </span>
          ) : (
            <span>{t('setup.telegram.testHint', { bot: bot?.username ? `@${bot.username}` : '' })}</span>
          )}
        </div>
      )}

      {error && <p className="text-[12.5px] text-danger">{error}</p>}
      {checked && <p className="text-[11.5px] text-fg-3">{t('setup.telegram.pairing')}</p>}

      <div className="flex items-center justify-between gap-2">
        <GlassButton type="button" variant="ghost" onClick={onDone} disabled={busy !== null}>
          {t('setup.later')}
        </GlassButton>
        <div className="flex gap-2">
          {!checked && (
            <GlassButton type="submit" variant="primary" disabled={busy !== null || !token.trim()}>
              {busy === 'check' ? <Spinner /> : null} {t('setup.telegram.check')}
            </GlassButton>
          )}
          {checked && !trip?.ok && (
            <GlassButton type="button" variant="ghost" onClick={() => void test()} disabled={busy !== null}>
              {busy === 'test' ? <Spinner /> : null} {busy === 'test' ? t('setup.telegram.waiting') : t('setup.telegram.test')}
            </GlassButton>
          )}
          {checked && <Footer onNext={() => void save()} label={t('setup.telegram.save')} busy={busy === 'save'} disabled={busy !== null} />}
        </div>
      </div>
    </form>
  )
}
