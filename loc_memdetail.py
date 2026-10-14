# -*- coding: utf-8 -*-
import io

EN = """  // Memory detail card
  'memoryDetail.kind.preference': 'Preference',
  'memoryDetail.kind.project': 'Project',
  'memoryDetail.kind.person': 'Person',
  'memoryDetail.kind.knowledge': 'Knowledge',
  'memoryDetail.file.memory': 'Hermes memory',
  'memoryDetail.file.user': 'About you',
  'memoryDetail.content': 'Content',
  'memoryDetail.contentAria': 'Memory content',
  'memoryDetail.source': 'Source',
  'memoryDetail.updated': 'Last updated',
  'memoryDetail.usedIn': 'Used in',
  'memoryDetail.conversations.one': '{count} recent conversation',
  'memoryDetail.conversations.other': '{count} recent conversations',
  'memoryDetail.forgetAsk': 'Forget this memory?',
  'memoryDetail.forget': 'Forget',
  'memoryDetail.edit': 'Edit memory',
  'memoryDetail.save': 'Save',
  'memoryDetail.cancel': 'Cancel',
  'memoryDetail.tooLarge': 'This file is too large to edit safely from here. Open it in an editor from the header menu instead.',
"""

FR = """  // Memory detail card
  'memoryDetail.kind.preference': 'Pr\\u00e9f\\u00e9rence',
  'memoryDetail.kind.project': 'Projet',
  'memoryDetail.kind.person': 'Personne',
  'memoryDetail.kind.knowledge': 'Connaissance',
  'memoryDetail.file.memory': 'M\\u00e9moire de Hermes',
  'memoryDetail.file.user': '\\u00c0 votre sujet',
  'memoryDetail.content': 'Contenu',
  'memoryDetail.contentAria': 'Contenu de la m\\u00e9moire',
  'memoryDetail.source': 'Source',
  'memoryDetail.updated': 'Derni\\u00e8re mise \\u00e0 jour',
  'memoryDetail.usedIn': 'Utilis\\u00e9e dans',
  'memoryDetail.conversations.one': '{count} conversation r\\u00e9cente',
  'memoryDetail.conversations.other': '{count} conversations r\\u00e9centes',
  'memoryDetail.forgetAsk': 'Oublier cette m\\u00e9moire ?',
  'memoryDetail.forget': 'Oublier',
  'memoryDetail.edit': 'Modifier la m\\u00e9moire',
  'memoryDetail.save': 'Enregistrer',
  'memoryDetail.cancel': 'Annuler',
  'memoryDetail.tooLarge': 'Ce fichier est trop volumineux pour \\u00eatre modifi\\u00e9 ici sans risque. Ouvrez-le plut\\u00f4t dans un \\u00e9diteur depuis le menu de l\\u2019en-t\\u00eate.',
"""

for path, block in [('apps/desktop/src/locales/en.ts', EN), ('apps/desktop/src/locales/fr.ts', FR)]:
    with io.open(path, 'r', encoding='utf-8', newline='') as f:
        s = f.read()
    if '  } as const' in s:
        idx = s.rfind('  } as const')
        out = s[:idx] + block + s[idx:]
    else:
        trimmed = s.rstrip()
        idx = trimmed.rfind('}')
        body = trimmed[:idx].rstrip()
        if not body.endswith(','):
            body += ','
        out = body + '\n' + block + '}\n'
    with io.open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(out)
    print(path, 'memoryDetail keys added')

# ---------------- memory-store.ts: KIND_LABEL / FILE_LABEL -> keys ----------------
path = 'apps/desktop/src/features/memory/memory-store.ts'
with io.open(path, 'r', encoding='utf-8') as f:
    s = f.read()

reps = [
    ("export const KIND_LABEL: Record<MemoryKind, string> = {\n  preference: 'Preference',\n  project: 'Project',\n  person: 'Person',\n  knowledge: 'Knowledge'\n}",
     "/** Each kind's catalogue key. The UI translates it at draw time. */\nexport const KIND_LABEL: Record<MemoryKind, MessageKey> = {\n  preference: 'memoryDetail.kind.preference',\n  project: 'memoryDetail.kind.project',\n  person: 'memoryDetail.kind.person',\n  knowledge: 'memoryDetail.kind.knowledge'\n}"),
]

missing = []
for old, new in reps:
    if old not in s:
        missing.append(old[:80])
    else:
        s = s.replace(old, new, 1)

# FILE_LABEL: read it first
print('--- FILE_LABEL block ---')
i = s.index('export const FILE_LABEL')
print(s[i : i + 220])

if missing:
    print('STORE MISSING:', missing)
else:
    with io.open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(s)
    print('memory-store.ts KIND_LABEL updated')
