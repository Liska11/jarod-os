// Runs before the app, in old JavaScript on purpose: on a WebView too old to even parse the app,
// the person gets an explanation instead of a blank screen. The app needs X25519 in WebCrypto
// (Chrome / Android System WebView 133 or later).
;(function () {
  var version = /Chrome\/(\d+)/.exec(navigator.userAgent)
  var major = version ? parseInt(version[1], 10) : 0

  function explain() {
    var root = document.getElementById('root')
    if (!root || root.getAttribute('data-ready')) return
    root.innerHTML =
      '<main style="padding:24px;font-family:sans-serif;color:#f3f7ff;line-height:1.5">' +
      '<h1 style="margin:0 0 12px">Jarod</h1>' +
      '<p>Le composant Web de ce téléphone est trop ancien' +
      (major ? ' (version ' + major + ')' : '') +
      ' pour le chiffrement de Jarod.</p>' +
      '<p>Ouvrez le <b>Play Store</b>, mettez à jour <b>Android System WebView</b> et <b>Chrome</b>, puis rouvrez l’appli.</p>' +
      '<p style="opacity:.7;font-size:13px">Version 133 ou plus nécessaire.</p></main>'
  }

  if (major && major < 133) {
    window.__jarodTooOld = true
    document.addEventListener('DOMContentLoaded', explain)
    return
  }
  try {
    window.crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']).then(null, function () {
      window.__jarodTooOld = true
      explain()
    })
  } catch (e) {
    window.__jarodTooOld = true
    document.addEventListener('DOMContentLoaded', explain)
  }
})()
