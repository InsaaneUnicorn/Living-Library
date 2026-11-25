import Papa from 'papaparse'
import { binderSortFields } from './binder'
import type { OwnedFinish } from './binder'
import type { ImportedImage, Preferences } from './preferences'

export type BinderFileFormat = 'json' | 'csv'
export type BinderFileCard = {
  scryfallId: string
  slot: number | null
  quantity: number
  finish: OwnedFinish
  condition: string
  tags: string[]
}
export type BinderFile = {
  version: 1
  name: string
  reservedSpreads: number
  preferences: Preferences
  cards: BinderFileCard[]
}

const csvColumns = ['record', 'scryfall_id', 'slot', 'quantity', 'finish', 'condition_json', 'tags_json', 'binder_json']
export const maxBinderFileSize = 10 * 1024 * 1024

export function serializeBinder(file: BinderFile, format: BinderFileFormat) {
  if (format === 'json') return JSON.stringify(file, null, 2)
  const { cards, ...metadata } = file
  // JSON cells preserve arbitrary labels and line breaks without creating spreadsheet formulas.
  return Papa.unparse([csvColumns, ['binder', '', '', '', '', '', '', JSON.stringify(metadata)],
    ...cards.map((card) => [
      'card', card.scryfallId, card.slot ?? '', card.quantity, card.finish,
      JSON.stringify(card.condition), JSON.stringify(card.tags), '',
    ]),
  ], { escapeFormulae: true })
}

function parseCsv(text: string): unknown {
  const { data, errors } = Papa.parse<string[]>(text, { delimiter: ',', skipEmptyLines: 'greedy' })
  const [header, metadata, ...cards] = data
  if (errors.length || header?.length !== csvColumns.length ||
      !csvColumns.every((column, index) => column === header[index]) ||
      metadata?.length !== csvColumns.length || metadata[0] !== 'binder') {
    throw new Error('Choose a Living Library binder CSV with its original headers.')
  }
  return {
    ...JSON.parse(metadata[7]),
    cards: cards.map((row) => {
      if (row[0] !== 'card' || row.length !== csvColumns.length) throw new Error('A CSV card row is malformed.')
      return {
        scryfallId: row[1], slot: row[2] === '' ? null : Number(row[2]), quantity: Number(row[3]),
        finish: row[4], condition: JSON.parse(row[5]), tags: JSON.parse(row[6]),
      }
    }),
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

function isOneOf(value: unknown, choices: string[]) {
  return typeof value === 'string' && choices.includes(value)
}

function isImage(value: unknown): value is ImportedImage {
  return isObject(value) && isText(value.name, 1024) && isText(value.src, 200_000) &&
    /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/]+=*$/i.test(value.src)
}

function isPreferences(value: unknown): value is Preferences {
  if (!isObject(value) || !isInteger(value.rows, 2, 4) || !isInteger(value.columns, 2, 4) ||
      !isInteger(value.spreads, 1, 1_000_000) || !isText(value.coverTitle, 40) ||
      !isOneOf(value.siteTheme, ['dark', 'light', 'forest']) ||
      !isOneOf(value.binderTheme, ['slate', 'burgundy', 'evergreen']) ||
      !isOneOf(value.binding, ['stitched', 'rings', 'plain']) || !isObject(value.coverImages) ||
      !Object.entries(value.coverImages).every(([side, image]) => isOneOf(side, ['front', 'back']) && isImage(image))) return false

  if (!Array.isArray(value.stickers) || value.stickers.length > 18 || !value.stickers.every((sticker: unknown) =>
    isObject(sticker) && isText(sticker.id, 60) && isText(sticker.text, 1024) &&
    isInteger(sticker.position, 0, 8) && isOneOf(sticker.side, ['front', 'back']) &&
    (sticker.image === undefined || isImage(sticker.image)))) return false

  const sorting = value.binderSorting
  return isObject(sorting) && isText(sorting.prioritizedTags, maxBinderFileSize) &&
    Array.isArray(sorting.rules) && sorting.rules.length >= 1 && sorting.rules.length <= Object.keys(binderSortFields).length &&
    sorting.rules.every((rule: unknown) => isObject(rule) && typeof rule.field === 'string' &&
      Object.hasOwn(binderSortFields, rule.field) && isOneOf(rule.direction, ['asc', 'desc'])) &&
    new Set(sorting.rules.map((rule) => rule.field)).size === sorting.rules.length
}

function isCard(value: unknown): value is BinderFileCard {
  return isObject(value) && isText(value.scryfallId, 100) && /^[a-z0-9][a-z0-9-]*$/i.test(value.scryfallId) &&
    (value.slot === null || isInteger(value.slot, 0, 31_999_999)) &&
    isInteger(value.quantity, 1, Number.MAX_SAFE_INTEGER) &&
    isOneOf(value.finish, ['foil', 'nonfoil', 'unspecified']) && isText(value.condition, 100) &&
    Array.isArray(value.tags) && value.tags.every((tag: unknown) => isText(tag, 40) && tag.trim().length > 0)
}

export function parseBinder(text: string, format: BinderFileFormat): BinderFile {
  let value: unknown
  try {
    value = format === 'csv' ? parseCsv(text) : JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('This file contains invalid binder data.', { cause: error })
    throw error
  }
  if (!isObject(value) || value.version !== 1 || !isText(value.name, 60) || !value.name.trim()) {
    throw new Error('Choose a Living Library binder export with a valid name and version.')
  }
  if (!isPreferences(value.preferences) || !isInteger(value.reservedSpreads, 1, 1_000_000)) {
    throw new Error('This file contains invalid binder settings.')
  }
  if (!Array.isArray(value.cards) || !value.cards.every(isCard)) {
    throw new Error('This file contains invalid card entries.')
  }
  const slots = value.cards.flatMap((card) => card.slot === null ? [] : [card.slot])
  if (new Set(slots).size !== slots.length) throw new Error('Two cards in this file use the same pocket.')
  return { version: 1, name: value.name.trim(), preferences: value.preferences,
    reservedSpreads: value.reservedSpreads, cards: value.cards }
}
