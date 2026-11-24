export const binderColumns = 3
export const binderRows = 3
export const binderPageSize = binderColumns * binderRows
export const binderPagesPerSpread = 2
export const binderSpreadSize = binderPageSize * binderPagesPerSpread

export type View = 'catalog' | 'binder'
export type OwnedFinish = 'foil' | 'nonfoil' | 'unspecified'
export type SelectionTarget = { slot: number; collectionId: number }

export const binderSortFields = {
  tag: 'Tag', name: 'Name', type: 'Card type', color: 'Mana color', mana: 'Mana value', set: 'Set',
  slot: 'Custom binder slot',
}
export type BinderSortRule = { field: keyof typeof binderSortFields; direction: 'asc' | 'desc' }
export type BinderSorting = { rules: BinderSortRule[]; prioritizedTags: string }
export const defaultBinderSorting: BinderSorting = { rules: [{ field: 'tag', direction: 'asc' }], prioritizedTags: '' }

export type BinderFilters = {
  name: string
  typeLine: string
  color: string
  manaCost: string
  sets: string
  tag: string
  tagOrder: '' | 'asc' | 'desc' | 'priorities'
}

export const defaultBinderFilters: BinderFilters = {
  name: '', typeLine: '', color: '', manaCost: '', sets: '', tag: '', tagOrder: '',
}

export const legalityFormatNames: Record<string, string> = {
  commander: 'Commander', pauper: 'Pauper', pioneer: 'Pioneer', standard: 'Standard',
  modern: 'Modern', legacy: 'Legacy', vintage: 'Vintage', brawl: 'Brawl',
  standardbrawl: 'Standard Brawl', historic: 'Historic', timeless: 'Timeless',
  alchemy: 'Alchemy', explorer: 'Explorer', oathbreaker: 'Oathbreaker', duel: 'Duel Commander',
  paupercommander: 'Pauper Commander', penny: 'Penny Dreadful', premodern: 'Premodern',
  oldschool: 'Old School', predh: 'PreDH', gladiator: 'Gladiator', future: 'Future Standard',
}

export type PrintingDetails = {
  setName: string
  legalities: Record<string, string>
  legalitiesComplete: boolean
  finishes: OwnedFinish[]
  owned: number
  ownedFoil: number
  ownedNonfoil: number
}

export type CatalogFilters = {
  query: string
  languages: string[]
  set: string
  legalIn: string
  finish: '' | 'foil' | 'nonfoil'
  sort: 'name' | 'name-desc' | 'set'
}

export type CatalogRequest =
  | { type: 'load'; pageSize?: number; binderSorting?: BinderSorting }
  | { type: 'view'; view: View }
  | { type: 'search'; filters: CatalogFilters }
  | { type: 'filter-binder'; filters: BinderFilters }
  | { type: 'page'; page: number }
  | { type: 'layout'; pageSize?: number; binderSorting: BinderSorting }
  | { type: 'details'; scryfallId: string }
  | { type: 'place'; scryfallId: string; slot: number; finish: OwnedFinish }
  | { type: 'move'; from: number; slot: number }
  | { type: 'remove'; targets: SelectionTarget[] }
  | { type: 'tag'; targets: SelectionTarget[]; tag: string }
  | { type: 'sync'; force?: boolean }

export const defaultFilters: CatalogFilters = {
  query: '', languages: [], set: '', legalIn: '', finish: '', sort: 'name',
}
