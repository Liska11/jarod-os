// La bulle de Jarod. Elle affiche le résumé que le main lui pousse (textes déjà bornés par lui), se déplace à la souris et se clique :
// `jarodMini.drag(dx, dy)` et `jarodMini.click()` sont ses deux seuls envois.
;(() => {
  const orb = document.getElementById('orb')
  const count = document.getElementById('count')
  const ASK = { approval: 'Accord demandé', clarify: 'Question de Jarod', sudo: 'Mot de passe administrateur demandé', secret: 'Secret demandé' }
  const VOICE = { listening: 'Jarod écoute', thinking: 'Jarod réfléchit', speaking: 'Jarod parle' }

  function render(s) {
    if (!s || typeof s !== 'object') return
    const waiting = Array.isArray(s.waiting) ? s.waiting : []
    const working = Array.isArray(s.working) ? s.working : []
    let state = 'idle'
    let label = 'Jarod'
    let n = 0

    if (s.waitingCount > 0 && waiting[0]) {
      state = 'waiting'
      label = `${ASK[waiting[0].kind] || 'Réponse attendue'} — cliquer pour répondre`
      n = s.waitingCount
    } else if (s.voice && VOICE[s.voice]) {
      state = s.voice
      label = VOICE[s.voice]
    } else if (s.workingCount > 0 && working[0]) {
      state = 'working'
      label = working[0].status ? `${working[0].title} — ${working[0].status}` : working[0].title || 'Jarod travaille…'
      n = s.workingCount
    } else if (s.agents > 0) {
      state = 'working'
      label = `${s.agents} sous-agent(s) au travail`
    }

    orb.className = `orb ${state}${orb.classList.contains('dragging') ? ' dragging' : ''}`
    orb.title = label
    orb.setAttribute('aria-label', label)
    count.hidden = n < 2
    count.textContent = n > 99 ? '99+' : String(n)
  }

  // Déplacement : on suit la souris (capturée) et on envoie la différence de position ; moins de 5 px au total, c'est un clic.
  let down = null
  orb.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    down = { x: e.screenX, y: e.screenY, lastX: e.screenX, lastY: e.screenY, moved: false }
    orb.setPointerCapture(e.pointerId)
  })
  orb.addEventListener('pointermove', (e) => {
    if (!down) return
    if (!down.moved && Math.hypot(e.screenX - down.x, e.screenY - down.y) < 5) return
    down.moved = true
    orb.classList.add('dragging')
    const dx = e.screenX - down.lastX
    const dy = e.screenY - down.lastY
    down.lastX = e.screenX
    down.lastY = e.screenY
    if ((dx || dy) && window.jarodMini) window.jarodMini.drag(dx, dy)
  })
  const release = (e) => {
    if (!down) return
    const wasClick = !down.moved
    down = null
    orb.classList.remove('dragging')
    if (orb.hasPointerCapture(e.pointerId)) orb.releasePointerCapture(e.pointerId)
    if (wasClick && e.type === 'pointerup' && window.jarodMini) window.jarodMini.click()
  }
  orb.addEventListener('pointerup', release)
  orb.addEventListener('pointercancel', release)

  if (window.jarodMini) window.jarodMini.onSummary(render)
})()
