/** Puts text on the clipboard. The async API first; a hidden text box when the page may not use it (no focus, no permission). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)

    return true
  } catch {
    // Fall through to the selection-based copy.
  }

  const box = document.createElement('textarea')
  box.value = text
  box.setAttribute('readonly', '')
  box.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
  document.body.appendChild(box)
  box.select()

  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    box.remove()
  }
}

/** Hands a text to the user as a file: the browser layer asks where to save it. */
export function downloadText(name: string, text: string, type = 'text/markdown;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  // The download has started by the time the task ends; the address is no longer needed.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
