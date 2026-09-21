import { App } from './core/App'
import { SCENES } from './game/registry'

const bootEl = document.getElementById('boot')
const fatalEl = document.getElementById('fatal')

function fatal(err: unknown): void {
  console.error(err)
  if (!fatalEl) return
  fatalEl.style.display = 'grid'
  fatalEl.textContent = `California Games failed to start.\n\n${err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err)}`
  bootEl?.classList.add('gone')
}

/** `?scene=bmx` jumps straight to an event, which is how review captures are taken. */
function startScene(): string {
  const wanted = new URLSearchParams(location.search).get('scene')
  return wanted && wanted in SCENES ? wanted : 'menu'
}

async function start(): Promise<void> {
  const mount = document.getElementById('app')
  if (!mount) throw new Error('#app mount not found')

  const app = new App()
  await app.boot(mount)

  for (const [id, factory] of Object.entries(SCENES)) app.register(id, factory)

  // Text is measured at construction, so the display face must be resident
  // before the first scene builds its HUD or every label silently falls back.
  await document.fonts.ready

  await app.run(startScene())

  // Reveal only once the first real frame is on screen, so "playable" is honest.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      bootEl?.classList.add('gone')
      window.setTimeout(() => bootEl?.remove(), 400)
      ;(window as unknown as Record<string, unknown>).__cgReady = true
      performance.mark('cg-playable')
    })
  })

  window.addEventListener('keydown', (e) => {
    if (e.code === 'F1' || (e.code === 'KeyP' && e.shiftKey)) {
      app.perf.showOverlay(!app.perf.overlayVisible)
    }
  })
}

start().catch(fatal)
window.addEventListener('error', (e) => fatal(e.error ?? e.message))
window.addEventListener('unhandledrejection', (e) => fatal(e.reason))
