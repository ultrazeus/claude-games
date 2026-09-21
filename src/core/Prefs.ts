/**
 * Player audio preferences, persisted.
 *
 * `localStorage` throws outright in some contexts (a browser set to block site
 * data, a sandboxed frame, a thumbnail capture), so every access is guarded and
 * the defaults stand if it is unavailable. A game that fails to start because
 * it could not read a settings key would be a poor trade for remembering one.
 */
export interface Prefs {
  music: boolean
  /** The sustained wind/wave/tyre beds. Separate from music on purpose. */
  ambience: boolean
}

const KEY = 'cg.audio'
const DEFAULTS: Prefs = { music: true, ambience: true }

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const v = JSON.parse(raw) as Partial<Prefs>
    return {
      music: typeof v.music === 'boolean' ? v.music : DEFAULTS.music,
      ambience: typeof v.ambience === 'boolean' ? v.ambience : DEFAULTS.ambience,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* Preferences are a convenience; losing them is not worth an error path. */
  }
}
