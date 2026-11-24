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
}

export const defaultPreferences: Preferences = {
  rows: 3, columns: 3, siteTheme: 'dark', binderTheme: 'slate', binding: 'stitched',
  coverTitle: 'My Binder', coverImages: {}, stickers: [], spreads: 1,
}

const storageKey = 'living-library-preferences'
export function readPreferences(): Preferences {
  try {
    const saved = localStorage.getItem(storageKey)
    return saved ? { ...defaultPreferences, ...JSON.parse(saved) } : defaultPreferences
  } catch {
    return defaultPreferences
  }
}

export function savePreferences(preferences: Preferences) {
  localStorage.setItem(storageKey, JSON.stringify(preferences))
}


