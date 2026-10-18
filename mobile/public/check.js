// Runs before the app, in old JavaScript on purpose: on a WebView too old to run the app (built for
// Chrome 100, see vite.config.ts), the person gets an explanation instead of a blank screen.
// X25519 is not checked here: x25519-shim.ts supplies it to WebViews older than 133.
;(function () {
  var version = /Chrome\/(\d+)/.exec(navigator.userAgent)
  var major = version ? parseInt(version[1], 10) : 0
  if (!major || major >= 100) return
  window.__jarodTooOld = true
  document.addEventListener('DOMContentLoaded', function () {
    var root = document.getElementById('root')
    if (!root) return
    root.innerHTML =
      '<main style="padding:24px;font-family:sans-serif;color:#f3f7ff;line-height:1.5">' +
      '<h1 style="margin:0 0 12px">Jarod</h1>' +
      '<p>Le composant Web de ce téléphone est trop ancien (version ' + major + ').</p>' +
      '<p>Ouvrez le <b>Play Store</b>, mettez à jour <b>Android System WebView</b> et <b>Chrome</b>, puis rouvrez l’appli.</p>' +
      '<p style="opacity:.7;font-size:13px">Version 100 ou plus nécessaire.</p></main>'
  })
})()
