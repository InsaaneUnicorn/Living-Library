import { defaultBinderId, defaultBinderSorting } from './binder'
import type { BinderSorting } from './binder'

export type CoverSide = 'front' | 'back'
export type ImportedImage = { src: string; name: string }
type Sticker = { id: string; text: string; position: number; side: CoverSide; image?: ImportedImage }

export type Preferences = {
  rows: number
  columns: number
  siteTheme: 'dark' | 'light' | 'forest'
  binderTheme: 'slate' | 'burgundy' | 'evergreen'
  binding: 'stitched' | 'rings' | 'plain'
  coverTitle: string
  coverImages: Partial<Record<CoverSide, ImportedImage>>
  stickers: Sticker[]
  spreads: number
  binderSorting: BinderSorting
}

export const defaultPreferences: Preferences = {
  rows: 3, columns: 3, siteTheme: 'dark', binderTheme: 'slate', binding: 'stitched',
  coverTitle: 'My Binder', coverImages: {}, stickers: [], spreads: 1,
  binderSorting: defaultBinderSorting,
}

const storageKey = 'living-library-preferences'
const activeBinderKey = 'living-library-active-binder'

export function readActiveBinder(): string {
  try {
    return localStorage.getItem(activeBinderKey) || defaultBinderId
  } catch {
    return defaultBinderId
  }
}

export function saveActiveBinder(id: string) {
  try {
    localStorage.setItem(activeBinderKey, id)
  } catch {
    // The binder is still saved in SQLite. Only the startup selection is lost.
  }
}

function preferencesKey(id: string) {
  return id === defaultBinderId ? storageKey : `${storageKey}:${id}`
}

export function readPreferences(id = defaultBinderId): Preferences {
  try {
    const saved = localStorage.getItem(preferencesKey(id))
    return saved ? { ...defaultPreferences, ...JSON.parse(saved) } : defaultPreferences
  } catch {
    return defaultPreferences
  }
}

export function savePreferences(preferences: Preferences, id = defaultBinderId) {
  localStorage.setItem(preferencesKey(id), JSON.stringify(preferences))
}

export function removeImportedPreferences(id: string) {
  try {
    localStorage.removeItem(preferencesKey(id))
  } catch {
    // A failed import's unused settings do not affect any saved binder.
  }
}

