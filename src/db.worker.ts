import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import type { Database } from '@sqlite.org/sqlite-wasm'
import { binderSpreadSize, defaultFilters } from './binder'
import type { CatalogRequest, OwnedFinish, PrintingDetails, View } from './binder'

type ImageUris = Record<string, string>

type ScryfallCard = {
  id: string
  name: string
  set: string
  set_name: string
  collector_number: string
  lang: string
  finishes: string[]
  legalities: Record<string, string>
  image_uris?: ImageUris
  card_faces?: { image_uris?: ImageUris }[]
}

type BulkExport = {
  type: string
  updated_at: string
  jsonl_download_uri: string
}

const bulkUrl = 'https://api.scryfall.com/bulk-data'
const printingColumns = `
  scryfall_id, name, set_code, set_name, collector_number,
  language, foil, nonfoil, allowed_formats, image_uris
`
let database: ReturnType<typeof openCatalog> | undefined
let view: View = 'catalog'
let filters = defaultFilters
let activePage = 0
let binderSpreadCapacity = binderSpreadSize
let syncing = false
let languages: string[] = []

async function openCatalog() {
  const sqlite = await sqlite3InitModule()
  const { OpfsSAHPoolDb } = await sqlite.installOpfsSAHPoolVfs({ initialCapacity: 6 })
  const collection = new OpfsSAHPoolDb('/collection.sqlite3')
  try {
    collection.exec(`
      CREATE TABLE IF NOT EXISTS collection_entries (
        id INTEGER PRIMARY KEY,
        scryfall_id TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        finish TEXT NOT NULL,
        condition TEXT NOT NULL,
        binder TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS binder_page_reserve (
        binder TEXT PRIMARY KEY,
        spreads INTEGER NOT NULL CHECK (spreads > 0)
      );
    `)
    if (!collection.selectObjects('PRAGMA table_info(collection_entries)').some((column) => column.name === 'slot')) {
      collection.exec('ALTER TABLE collection_entries ADD COLUMN slot INTEGER CHECK (slot >= 0)')
    }
    collection.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS collection_slot ON collection_entries (binder, slot);
      CREATE INDEX IF NOT EXISTS collection_printing ON collection_entries (scryfall_id);
    `)
  } catch (error) {
    collection.close()
    throw error
  }

  const catalog = new OpfsSAHPoolDb('/catalog.sqlite3')
  try {
    catalog.exec(`
      CREATE TABLE IF NOT EXISTS card_printings (
        id INTEGER PRIMARY KEY,
        scryfall_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        set_code TEXT NOT NULL,
        set_name TEXT NOT NULL,
        collector_number TEXT NOT NULL,
        language TEXT NOT NULL,
        foil INTEGER NOT NULL CHECK (foil IN (0, 1)),
        nonfoil INTEGER NOT NULL CHECK (nonfoil IN (0, 1)),
        allowed_formats TEXT CHECK (json_type(allowed_formats) = 'array'),
        image_uris TEXT CHECK (image_uris IS NULL OR json_valid(image_uris))
      );
      CREATE TABLE IF NOT EXISTS catalog_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        updated_at TEXT NOT NULL
      );
    `)
    return { catalog, collection }
  } catch (error) {
    catalog.close()
    collection.close()
    throw error
  }
}

async function* streamCards(body: ReadableStream<BufferSource>) {
  const reader = body.pipeThrough(new DecompressionStream('gzip'))
    .pipeThrough(new TextDecoderStream('utf-8', { fatal: true }))
    .getReader()
  let remainder = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const lines = (remainder + value).split('\n')
      remainder = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim()) yield JSON.parse(line) as ScryfallCard
      }
    }
    if (remainder.trim()) yield JSON.parse(remainder) as ScryfallCard
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function replaceCatalog(catalog: Database, source: BulkExport, force: boolean) {
  const response = await fetch(source.jsonl_download_uri, { cache: force ? 'reload' : 'default' })
  if (!response.ok || !response.body) {
    throw new Error(`Scryfall catalog download failed (HTTP ${response.status}).`)
  }

  // Keep the previous catalog visible while the new export is being staged.
  catalog.exec('BEGIN')
  try {
    catalog.exec(`
      CREATE TABLE incoming_printings AS SELECT ${printingColumns} FROM card_printings WHERE 0;
      CREATE UNIQUE INDEX incoming_printing_id ON incoming_printings(scryfall_id);
    `)

    const statement = catalog.prepare(`
      INSERT INTO incoming_printings (${printingColumns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    let count = 0
    try {
      for await (const card of streamCards(response.body)) {
        const formats = Object.keys(card.legalities).filter((format) => card.legalities[format] === 'legal')
        const images = card.image_uris ?? card.card_faces?.map((face) => face.image_uris ?? null)
        statement.bind([
          card.id, card.name, card.set, card.set_name, card.collector_number,
          card.lang, Number(card.finishes.includes('foil')),
          Number(card.finishes.includes('nonfoil')), JSON.stringify(formats),
          images ? JSON.stringify(images) : null,
        ])
        statement.step()
        statement.reset()
        count += 1
        if (count % 10_000 === 0) {
          self.postMessage({ type: 'sync', message: `Importing catalog (This will take a few minutes)… ${count.toLocaleString()} printings processed` })
        }
      }
    } finally {
      statement.finalize()
    }

    if (!count) throw new Error('Scryfall returned an empty catalog.')
    catalog.exec(`
      INSERT INTO card_printings (${printingColumns})
      SELECT ${printingColumns} FROM incoming_printings WHERE 1
      ON CONFLICT(scryfall_id) DO UPDATE SET
        name = excluded.name,
        set_code = excluded.set_code,
        set_name = excluded.set_name,
        collector_number = excluded.collector_number,
        language = excluded.language,
        foil = excluded.foil,
        nonfoil = excluded.nonfoil,
        allowed_formats = excluded.allowed_formats,
        image_uris = excluded.image_uris;

      DELETE FROM card_printings
      WHERE NOT EXISTS (
        SELECT 1 FROM incoming_printings
        WHERE incoming_printings.scryfall_id = card_printings.scryfall_id
      );

      DROP TABLE incoming_printings;
    `)
    catalog.exec({
      sql: 'INSERT OR REPLACE INTO catalog_version (id, updated_at) VALUES (1, ?)',
      bind: [source.updated_at],
    })
    catalog.exec('COMMIT')
  } catch (error) {
    try {
      catalog.exec('ROLLBACK')
    } catch {
      // SQLite can already have rolled back a failed write.
    }
    throw error
  }
}

const cardSummary = 'id, scryfall_id, name, set_code, collector_number, language, image_uris'
const mainBinder = 'main'
const sortOrders = {
  name: 'name COLLATE NOCASE, set_code, collector_number, id',
  'name-desc': 'name COLLATE NOCASE DESC, set_code, collector_number, id',
  set: 'set_name COLLATE NOCASE, set_code, CAST(collector_number AS INTEGER), collector_number, id',
}

function catalogRows(catalog: Database, offset: number) {
  const conditions = ['instr(lower(name), lower(?)) > 0']
  const values: (string | number)[] = [filters.query.trim()]
  if (filters.languages.length) {
    conditions.push(`language IN (${filters.languages.map(() => '?').join(', ')})`)
    values.push(...filters.languages)
  }
  if (filters.set.trim()) {
    conditions.push('(lower(set_code) = lower(?) OR instr(lower(set_name), lower(?)) > 0)')
    values.push(filters.set.trim(), filters.set.trim())
  }
  if (filters.format.trim()) {
    conditions.push('EXISTS (SELECT 1 FROM json_each(allowed_formats) WHERE value = lower(?))')
    values.push(filters.format.trim())
  }
  if (filters.finish === 'foil' || filters.finish === 'nonfoil') conditions.push(`${filters.finish} = 1`)

  return catalog.selectObjects(
    `SELECT ${cardSummary} FROM card_printings
     WHERE ${conditions.join(' AND ')} ORDER BY ${sortOrders[filters.sort] ?? sortOrders.name}
     LIMIT ? OFFSET ?`,
    [...values, binderSpreadSize + 1, offset],
  )
}

function collectionRows({ catalog, collection }: Awaited<ReturnType<typeof openCatalog>>, offset: number) {
  const entries = collection.selectObjects(
    'SELECT id, scryfall_id, slot, finish FROM collection_entries WHERE binder = ? AND slot >= ? AND slot < ?',
    [mainBinder, offset, offset + binderSpreadCapacity],
  )
  const rows = Array.from({ length: binderSpreadCapacity }, (_, index) => {
    const entry = entries.find((entry) => entry.slot === offset + index)
    if (!entry) return null
    const card = catalog.selectObject(`SELECT ${cardSummary} FROM card_printings WHERE scryfall_id = ?`, [entry.scryfall_id])
    return { ...(card ?? {
      id: entry.id, scryfall_id: entry.scryfall_id, name: 'Printing unavailable',
      set_code: '', collector_number: '', language: '', image_uris: null,
    }), ownedFinish: entry.finish }
  })
  return rows
}

function availableFinishes(printing: { foil?: unknown; nonfoil?: unknown }): OwnedFinish[] {
  const finishes: OwnedFinish[] = []
  if (printing.nonfoil) finishes.push('nonfoil')
  if (printing.foil) finishes.push('foil')
  return finishes.length ? finishes : ['unspecified']
}

function printingDetails({ catalog, collection }: Awaited<ReturnType<typeof openCatalog>>, id: string): PrintingDetails {
  const printing = catalog.selectObject(
    'SELECT set_name, allowed_formats, foil, nonfoil FROM card_printings WHERE scryfall_id = ?', [id],
  )
  if (!printing) throw new Error('This printing is no longer in the catalog.')
  const owned = collection.selectObject(
    `SELECT coalesce(sum(quantity), 0) AS total,
            coalesce(sum(quantity) FILTER (WHERE finish = 'foil'), 0) AS foil,
            coalesce(sum(quantity) FILTER (WHERE finish = 'nonfoil'), 0) AS nonfoil
     FROM collection_entries WHERE scryfall_id = ?`, [id],
  )
  return {
    setName: String(printing.set_name),
    formats: JSON.parse(String(printing.allowed_formats ?? '[]')),
    finishes: availableFinishes(printing),
    owned: Number(owned?.total ?? 0),
    ownedFoil: Number(owned?.foil ?? 0),
    ownedNonfoil: Number(owned?.nonfoil ?? 0),
  }
}

function lastBinderSlot(collection: Database) {
  return Number(collection.selectValue(
    'SELECT max(slot) FROM collection_entries WHERE binder = ?', [mainBinder],
  ) ?? -1)
}

function reserveNextSpread(collection: Database) {
  const lastSlot = lastBinderSlot(collection)
  if (lastSlot < 0) return

  const spread = Math.floor(lastSlot / binderSpreadCapacity)
  const pageSize = binderSpreadCapacity / 2
  const rightPageStart = spread * binderSpreadCapacity + pageSize
  if (lastSlot < rightPageStart) return

  const occupied = Number(collection.selectValue(
    'SELECT count(*) FROM collection_entries WHERE binder = ? AND slot >= ? AND slot < ?',
    [mainBinder, rightPageStart, rightPageStart + pageSize],
  ))
  if (occupied < pageSize - 1) return

  const spreads = spread + 2
  const reserved = Number(collection.selectValue('SELECT spreads FROM binder_page_reserve WHERE binder = ?', [mainBinder]) ?? 1)
  if (reserved >= spreads) return
  collection.exec({
    sql: `INSERT INTO binder_page_reserve (binder, spreads) VALUES (?, ?)
          ON CONFLICT(binder) DO UPDATE SET spreads = max(spreads, excluded.spreads)`,
    bind: [mainBinder, spreads],
  })
}

function editBinder({ catalog, collection }: Awaited<ReturnType<typeof openCatalog>>,
  request: Extract<CatalogRequest, { type: 'place' | 'move' }>) {
  const { slot } = request
  const offset = activePage * binderSpreadCapacity
  if (view !== 'binder' || !Number.isSafeInteger(slot) || slot < offset || slot >= offset + binderSpreadCapacity) {
    throw new Error('Select a pocket on the current binder spread.')
  }

  collection.transaction(() => {
    const target = collection.selectValue('SELECT id FROM collection_entries WHERE binder = ? AND slot = ?', [mainBinder, slot])
    if (request.type === 'place') {
      if (target != null) throw new Error('Choose an empty pocket for this card.')
      const printing = catalog.selectObject('SELECT foil, nonfoil FROM card_printings WHERE scryfall_id = ?', [request.scryfallId])
      if (!printing) throw new Error('This printing is no longer in the catalog.')
      if (!availableFinishes(printing).includes(request.finish)) throw new Error('Choose an available finish for this printing.')
      collection.exec({
        sql: `INSERT INTO collection_entries (scryfall_id, quantity, finish, condition, binder, slot)
              VALUES (?, 1, ?, 'unspecified', ?, ?)`,
        bind: [request.scryfallId, request.finish, mainBinder, slot],
      })
      reserveNextSpread(collection)
      return
    }

    const source = collection.selectValue('SELECT id FROM collection_entries WHERE binder = ? AND slot = ?', [mainBinder, request.from])
    if (source == null) throw new Error('The selected card is no longer in that pocket.')
    if (source === target) return
    const sql = 'UPDATE collection_entries SET slot = ? WHERE id = ?'
    if (target != null) collection.exec({ sql, bind: [null, target] })
    collection.exec({ sql, bind: [slot, source] })
    if (target != null) collection.exec({ sql, bind: [request.from, target] })
    reserveNextSpread(collection)
  })
}

function publishResults(db: Awaited<ReturnType<typeof openCatalog>>, edited = false) {
  const capacity = view === 'binder' ? binderSpreadCapacity : binderSpreadSize
  const offset = activePage * capacity
  const rows = view === 'catalog' ? catalogRows(db.catalog, offset) : collectionRows(db, offset)
  const lastSlot = lastBinderSlot(db.collection)
  const reservedSpreads = Number(db.collection.selectValue(
    'SELECT spreads FROM binder_page_reserve WHERE binder = ?', [mainBinder],
  ) ?? 1)
  self.postMessage({
    type: 'results',
    view, languages, edited, lastSlot, reservedSpreads,
    rows: rows.slice(0, capacity),
    page: activePage,
    hasMore: view === 'binder' || rows.length > binderSpreadSize,
    updatedAt: db.catalog.selectValue('SELECT updated_at FROM catalog_version WHERE id = 1') ?? null,
  })
}

function refreshLanguages(catalog: Database) {
  languages = catalog.selectObjects('SELECT DISTINCT language FROM card_printings ORDER BY language')
    .map((row) => String(row.language))
}

async function syncCatalog(db: Awaited<ReturnType<typeof openCatalog>>, force: boolean) {
  if (syncing) return
  const { catalog } = db
  syncing = true
  self.postMessage({ type: 'sync', message: 'Checking Scryfall for catalog updates…' })
  try {
    const response = await fetch(bulkUrl, {
      headers: { Accept: 'application/json' },
      cache: 'no-cache',
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`Scryfall returned HTTP ${response.status}.`)
    const manifest: { data: BulkExport[] } = await response.json()
    const source = manifest.data.find((entry) => entry.type === 'all_cards')
    if (!source?.jsonl_download_uri || !Number.isFinite(Date.parse(source.updated_at))) {
      throw new Error('Scryfall did not provide a usable All Cards export.')
    }

    const localVersion = catalog.selectValue('SELECT updated_at FROM catalog_version WHERE id = 1')
    if (force || typeof localVersion !== 'string' || Date.parse(localVersion) < Date.parse(source.updated_at)) {
      self.postMessage({ type: 'sync', message: 'Downloading and importing the full card catalog…' })
      await replaceCatalog(catalog, source, force)
      refreshLanguages(catalog)
      if (view === 'catalog') activePage = 0
      publishResults(db)
    }
    self.postMessage({ type: 'sync', message: '' })
  } finally {
    syncing = false
  }
}

self.onmessage = async ({ data }: MessageEvent<CatalogRequest>) => {
  try {
    database ??= openCatalog()
    const db = await database
    if (data.type === 'sync') {
      await syncCatalog(db, data.force === true)
      return
    }
    if (data.type === 'details') {
      self.postMessage({ type: 'details', scryfallId: data.scryfallId, details: printingDetails(db, data.scryfallId) })
      return
    }
    if (data.type === 'place' || data.type === 'move') {
      editBinder(db, data)
      publishResults(db, true)
      return
    }
    if (data.type === 'load') refreshLanguages(db.catalog)
    if (data.type === 'layout' || data.type === 'load') {
      const size = data.pageSize ?? 0
      if (Number.isInteger(size) && size >= 4 && size <= 16) binderSpreadCapacity = size * 2
      reserveNextSpread(db.collection)
    }
    if (data.type === 'view') view = data.view
    if (data.type === 'search') filters = data.filters
    if (data.type === 'page') activePage = data.page
    else if (data.type !== 'layout' || view === 'binder') activePage = 0
    publishResults(db)
  } catch (error) {
    self.postMessage({
      type: 'error',
      operation: data.type,
      scryfallId: data.type === 'details' ? data.scryfallId : undefined,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
