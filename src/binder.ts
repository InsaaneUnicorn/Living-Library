export const binderColumns = 3
export const binderRows = 3
export const binderPageSize = binderColumns * binderRows
export const binderPagesPerSpread = 2
export const binderSpreadSize = binderPageSize * binderPagesPerSpread

export type View = 'catalog' | 'binder'
export type OwnedFinish = 'foil' | 'nonfoil' | 'unspecified'

export type PrintingDetails = {
  setName: string
  formats: string[]
  finishes: OwnedFinish[]
  owned: number
  ownedFoil: number
  ownedNonfoil: number
}

export type CatalogFilters = {
  query: string
  languages: string[]
  set: string
  format: string
  finish: '' | 'foil' | 'nonfoil'
  sort: 'name' | 'name-desc' | 'set'
}

export type CatalogRequest =
  | { type: 'load'; pageSize?: number }
  | { type: 'view'; view: View }
  | { type: 'search'; filters: CatalogFilters }
  | { type: 'page'; page: number }
  | { type: 'layout'; pageSize: number }
  | { type: 'details'; scryfallId: string }
  | { type: 'place'; scryfallId: string; slot: number; finish: OwnedFinish }
  | { type: 'move'; from: number; slot: number }
  | { type: 'sync'; force?: boolean }

export const defaultFilters: CatalogFilters = {
  query: '', languages: [], set: '', format: '', finish: '', sort: 'name',
}
