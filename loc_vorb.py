# -*- coding: utf-8 -*-
import io

# {assistant} is filled by the catalogue itself; no name variable needed
for path, want, repl in [
    ('apps/desktop/src/locales/en.ts', "  'voiceOrb.armed': 'Say \u201c{name}\u201d',\n", "  'voiceOrb.armed': 'Say \u201c{assistant}\u201d',\n"),
    ('apps/desktop/src/locales/fr.ts', "  'voiceOrb.armed': 'Dites \u00ab {name} \u00bb',\n", "  'voiceOrb.armed': 'Dites \u00ab {assistant} \u00bb',\n"),
]:
    s = io.open(path, encoding='utf-8', newline='').read()
    assert want in s, (path, 'armed')
    io.open(path, 'w', encoding='utf-8', newline='').write(s.replace(want, repl, 1))
    print(path, 'armed uses {assistant}')

# ---------------- PreviewPane.tsx ----------------
path = 'apps/desktop/src/features/studio/PreviewPane.tsx'
with io.open(path, 'r', encoding='utf-8') as f:
    s = f.read()

reps = [
    ("title=\"Reload\" aria-label=\"Reload preview\"", "title={t('preview.reload')} aria-label={t('preview.reloadAria')}"),
    ("title=\"Open in its own window\" aria-label=\"Open preview in its own window\"",
     "title={t('preview.ownWindow')} aria-label={t('preview.ownWindowAria')}"),
    ("? 'The site appears here once Hermes starts it or writes an index.html.'", "? t('preview.onceBuilt')"),
    (": 'Waiting for the site to start\u2026'", ": t('preview.awaitStart')"),
    ("? 'The preview is hidden while a Hermes panel is open.'", "? t('preview.hiddenByPanel')"),
    ("? 'Bring the Studio forward to see the preview.'", "? t('preview.bringForward')"),
    (": 'Opening\u2026'}", ": t('preview.loading')}"),
    ("openPreview(target, { root: root ?? undefined, title: 'Preview' })", "openPreview(target, { root: root ?? undefined, title: t('missionPreview.title') })"),
]

missing = []
for old, new in reps:
    if old not in s:
        missing.append(old[:85])
    else:
        s = s.replace(old, new, 1)

if missing:
    print('PREVIEWPANE MISSING (%d):' % len(missing))
    for x in missing:
        print('  -', repr(x))
else:
    with io.open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(s)
    print('PreviewPane.tsx localised')

# ---------------- VoiceOrb.tsx ----------------
path = 'apps/desktop/src/features/voice/VoiceOrb.tsx'
with io.open(path, 'r', encoding='utf-8') as f:
    s = f.read()

reps = [
    ("const LABEL: Record<VoiceState, string> = {\n  off: '',\n  armed: 'Say \"hey hermes\"',\n  connecting: 'Connecting\u2026',\n  listening: 'Listening',\n  transcribing: 'Got it\u2026',\n  thinking: 'Thinking',\n  speaking: 'Speaking'\n}",
     "const LABEL: Record<VoiceState, MessageKey | null> = {\n  off: null,\n  armed: 'voiceOrb.armed',\n  connecting: 'voiceOrb.connecting',\n  listening: 'voiceOrb.listening',\n  transcribing: 'voiceOrb.transcribing',\n  thinking: 'voiceOrb.thinking',\n  speaking: 'voiceOrb.speaking'\n}"),
    ("<span className=\"font-medium text-fg-2\">{LABEL[voice.state]}</span>",
     "<span className=\"font-medium text-fg-2\">{label && t(label)}</span>"),
    ("aria-label={voice.muted ? 'Unmute microphone' : 'Mute microphone'}",
     "aria-label={voice.muted ? t('voiceOrb.unmute') : t('voiceOrb.mute')}"),
    ("title=\"GPT-Live session time and today's estimated cost\">", "title={t('voiceOrb.costTitle')}>"),
    (">Live</span>", ">{t('voiceOrb.live')}</span>"),
    ("aria-label=\"Stop talking\"", "aria-label={t('voiceOrb.stop')}"),
    ("aria-label=\"End conversation\"", "aria-label={t('voiceOrb.end')}"),
]

missing = []
for old, new in reps:
    if old not in s:
        missing.append(old[:85])
    else:
        s = s.replace(old, new, 1)

if missing:
    print('VOICEORB MISSING (%d):' % len(missing))
    for x in missing:
        print('  -', repr(x))
else:
    # imports + the label binding inside the component
    a = "import { useStore } from '@nanostores/react'"
    s = s.replace(a, a + "\nimport { type MessageKey, t, useT } from '../../lib/i18n.ts'", 1)
    b = "export function VoiceOrb({ offsetClass = 'bottom-24' }: { offsetClass?: string }) {"
    assert b in s, 'component anchor'
    s = s.replace(b, b + "\n  useT()\n  const label = LABEL[voice.state]", 1)
    with io.open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(s)
    print('VoiceOrb.tsx localised')