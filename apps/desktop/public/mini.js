// Lot C : la mini-fenêtre. Elle affiche le résumé que le main lui pousse (textes déjà bornés par lui) ; elle n'envoie rien. Un clic ramène
// Jarod : c'est le main qui le voit (focus de la fenêtre), pas cette page.
;(() => {
  const pill = document.getElementById('pill')
  const line1 = document.getElementById('line1')
  const line2 = document.getElementById('line2')
  const count = document.getElementById('count')
  const ASK = { approval: 'Accord demandé', clarify: 'Question de Jarod', sudo: 'Mot de passe administrateur demandé', secret: 'Secret demandé' }

  function render(s) {
    if (!s || typeof s !== 'object') return
    const waiting = Array.isArray(s.waiting) ? s.waiting : []
    const working = Array.isArray(s.working) ? s.working : []
    let state = 'idle'
    let title = 'Jarod'
    let detail = 'Au repos'
    let n = 0

    if (s.waitingCount > 0 && waiting[0]) {
      state = 'waiting'
      title = ASK[waiting[0].kind] || 'Réponse attendue'
      detail = waiting[0].text || 'Cliquer pour ouvrir Jarod et répondre'
      n = s.waitingCount
    } else if (s.workingCount > 0 && working[0]) {
      state = 'working'
      title = working[0].title || 'Jarod répond'
      detail = working[0].status || 'Jarod travaille…'
      n = s.workingCount
    } else if (s.agents > 0) {
      state = 'working'
      title = 'Sous-agents au travail'
      detail = `${s.agents} en cours`
    }

    pill.className = `pill ${state}`
    // textContent seulement : jamais de HTML venu d'ailleurs.
    line1.textContent = title
    line2.textContent = detail
    count.hidden = n <= 1
    count.textContent = n > 1 ? String(n) : ''
  }

  if (window.jarodMini) window.jarodMini.onSummary(render)
})()
