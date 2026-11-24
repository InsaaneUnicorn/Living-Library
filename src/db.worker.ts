import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import type { Database } from '@sqlite.org/sqlite-wasm'
import { binderSpreadSize, defaultBinderSorting, defaultFilters } from './binder'
import type { BinderFilters, BinderSortRule, CatalogRequest, OwnedFinish, PrintingDetails, View } from './binder'

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
  type_line?: string
  colors?: string[]
  cmc?: number
  mana_cost?: string
  card_faces?: { image_uris?: ImageUris; colors?: string[]; mana_cost?: string }[]
}

type BulkExport = {
  type: string
  updated_at: string
  jsonl_download_uri: string
}

const bulkUrl = 'https://api.scryfall.com/bulk-data'
const printingColumns = `
  scryfall_id, name, set_code, set_name, collector_number,
  language, foil, nonfoil, legalities, image_uris, type_line, colors, mana_value, mana_costs
`
let database: ReturnType<typeof openCatalog> | undefined
let view: View = 'catalog'
let filters = defaultFilters
let activePage = 0
let customBinderPage = 0
let binderFilters: BinderFilters | null = null
let binderSorting = defaultBinderSorting
let binderMetadataReady = false
let legalitiesReady = false
let binderSpreadCapacity = binderSpreadSize
let syncing = false
let languages: string[] = []

async function openCatalog() {
  const sqlite = await sqlite3InitModule()
  const { OpfsSAHPoolDb } = await sqlite.installOpfsSAHPoolVfs({ initialCapacity: 6 })
  const collection = new OpfsSAHPoolDb('/collection.sqlite3')
  try {
    collection.exec(`
      PRAGMA foreign_keys = ON;
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
      CREATE TABLE IF NOT EXISTS collection_tags (
        collection_id INTEGER NOT NULL REFERENCES collection_entries(id) ON DELETE CASCADE,
        tag TEXT NOT NULL COLLATE NOCASE,
        PRIMARY KEY (collection_id, tag)
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
        legalities TEXT CHECK (json_type(legalities) = 'object'),
        image_uris TEXT CHECK (image_uris IS NULL OR json_valid(image_uris))
      );
      CREATE TABLE IF NOT EXISTS catalog_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        updated_at TEXT NOT NULL
      );
    `)
    const columns = catalog.selectObjects('PRAGMA table_info(card_printings)')
    for (const [name, type] of Object.entries({
      type_line: 'TEXT', colors: 'TEXT', mana_value: 'REAL', mana_costs: 'TEXT',
      legalities: "TEXT CHECK (json_type(legalities) = 'object')",
    })) {
      if (!columns.some((column) => column.name === name)) {
        catalog.exec(`ALTER TABLE card_printings ADD COLUMN ${name} ${type}`)
      }
    }
    binderMetadataReady = catalog.selectValue('SELECT updated_at FROM catalog_version WHERE id = 1') != null
      && catalog.selectValue('SELECT 1 FROM card_printings WHERE type_line IS NULL LIMIT 1') == null
    legalitiesReady = catalog.selectValue('SELECT 1 FROM card_printings WHERE legalities IS NULL LIMIT 1') == null
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
      INSERT INTO incoming_printings (${printingColumns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    let count = 0
    try {
      for await (const card of streamCards(response.body)) {
        const images = card.image_uris ?? card.card_faces?.map((face) => face.image_uris ?? null)
        const faceColors = card.card_faces?.filter((face) => face.colors != null)
        const colors = card.colors ?? (faceColors?.length ? [...new Set(faceColors.flatMap((face) => face.colors ?? []))] : null)
        const manaCosts = [card.mana_cost, ...(card.card_faces?.map((face) => face.mana_cost) ?? [])].filter(Boolean)
        statement.bind([
          card.id, card.name, card.set, card.set_name, card.collector_number,
          card.lang, Number(card.finishes.includes('foil')),
          Number(card.finishes.includes('nonfoil')), JSON.stringify(card.legalities ?? {}),
          images ? JSON.stringify(images) : null,
          card.type_line ?? '', colors ? JSON.stringify(colors) : null, card.cmc ?? null, JSON.stringify(manaCosts),
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
        legalities = excluded.legalities,
        image_uris = excluded.image_uris,
        type_line = excluded.type_line,
        colors = excluded.colors,
        mana_value = excluded.mana_value,
        mana_costs = excluded.mana_costs;

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
    binderMetadataReady = true
    legalitiesReady = true
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
  if (filters.legalIn) {
    conditions.push(`(EXISTS (SELECT 1 FROM json_each(legalities) WHERE key = ? AND value IN ('legal', 'restricted'))
      OR (legalities IS NULL AND EXISTS (SELECT 1 FROM json_each(allowed_formats) WHERE value = ?)))`)
    values.push(filters.legalIn, filters.legalIn)
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
  const conditions = ['binder = ?', 'slot IS NOT NULL']
  const values: (string | number)[] = [mainBinder]
  if (!binderFilters) {
    conditions.push('slot >= ?', 'slot < ?')
    values.push(offset, offset + binderSpreadCapacity)
  }
  if (binderFilters?.tag) {
    conditions.push('EXISTS (SELECT 1 FROM collection_tags WHERE collection_id = collection_entries.id AND tag = ?)')
    values.push(binderFilters.tag)
  }
  const customSort = binderFilters?.tagOrder === 'priorities'
  const tagOrder = customSort ? '' : binderFilters?.tagOrder
  const firstTag = tagOrder
    ? ', (SELECT min(tag COLLATE NOCASE) FROM collection_tags WHERE collection_id = collection_entries.id) AS first_tag'
    : ''
  const ordering = tagOrder ? `first_tag IS NULL, first_tag COLLATE NOCASE ${tagOrder === 'desc' ? 'DESC' : 'ASC'}, slot` : 'slot'
  const entries = collection.selectObjects(
    `SELECT id, scryfall_id, slot, finish,
            (SELECT json_group_array(tag) FROM collection_tags WHERE collection_id = collection_entries.id) AS tags${firstTag}
     FROM collection_entries WHERE ${conditions.join(' AND ')} ORDER BY ${ordering}`,
    values,
  )
  const filterByPrinting = binderFilters && (binderFilters.name || binderFilters.typeLine || binderFilters.color ||
    binderFilters.manaCost || binderFilters.sets)
  const printings = binderFilters && (filterByPrinting || customSort)
    ? matchingPrintings(catalog, binderFilters, entries.map((entry) => entry.scryfall_id)) : null
  const matchingEntries = filterByPrinting ? entries.filter((entry) => printings?.has(entry.scryfall_id)) : entries
  const visibleEntries = customSort && printings ? sortByBinderPriorities(matchingEntries, printings) : matchingEntries
  const rows = Array.from({ length: binderSpreadCapacity }, (_, index) => {
    const entry = binderFilters ? visibleEntries[offset + index] : entries.find((entry) => entry.slot === offset + index)
    if (!entry) return null
    const card = printings ? printings.get(entry.scryfall_id)
      : catalog.selectObject(`SELECT ${cardSummary} FROM card_printings WHERE scryfall_id = ?`, [entry.scryfall_id])
    return { ...(card ?? {
      id: entry.id, scryfall_id: entry.scryfall_id, name: 'Printing unavailable',
      set_code: '', collector_number: '', language: '', image_uris: null,
    }), ownedFinish: entry.finish, collectionId: entry.id, ownedSlot: entry.slot, tags: JSON.parse(String(entry.tags)) }
  })
  return { rows, matchCount: visibleEntries.length }
}

const binderCollator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })
const manaColorOrder = 'WUBRG'

function sortByBinderPriorities<T extends Record<string, unknown>>(
  entries: T[],
  printings: ReadonlyMap<unknown, Record<string, unknown>>,
) {
  const { rules, prioritizedTags } = binderSorting
  const tagRanks = prioritizedTags.split(/\r?\n/).map((tag) => tag.trim().toLowerCase()).filter(Boolean)
  const rankedEntries = entries.map((entry) => {
    const card = printings.get(entry.scryfall_id)
    const tags = (JSON.parse(String(entry.tags)) as string[]).sort(binderCollator.compare)
    const tagRank = tagRanks.findIndex((tag) => tags.some((value) => value.toLowerCase() === tag))
    const colors = card?.colors == null ? null : JSON.parse(String(card.colors)) as string[]
    const values: Record<BinderSortRule['field'], string | number | null> = {
      tag: tagRank < 0 ? tags[0] ?? null : tagRanks[tagRank],
      name: card?.name == null ? null : String(card.name),
      type: card?.type_line ? String(card.type_line) : null,
      color: colors ? [...manaColorOrder].flatMap((color, index) => colors.includes(color) ? [index + 1] : []).join('') : null,
      mana: card?.mana_value == null ? null : Number(card.mana_value),
      set: card?.set_name == null ? null : String(card.set_name),
      slot: Number(entry.slot),
    }
    return { entry, values, tagRank: tagRank < 0 ? Infinity : tagRank }
  })

  return rankedEntries.sort((left, right) => {
    for (const { field, direction } of rules) {
      if (field === 'tag' && left.tagRank !== right.tagRank) return left.tagRank < right.tagRank ? -1 : 1
      const a = left.values[field]
      const b = right.values[field]
      if (a === b) continue
      if (a === null) return 1
      if (b === null) return -1
      const order = typeof a === 'number' && typeof b === 'number'
        ? a - b : binderCollator.compare(String(a), String(b))
      if (order) return direction === 'desc' ? -order : order
    }
    return Number(left.entry.slot) - Number(right.entry.slot)
  }).map(({ entry }) => entry)
}

function matchingPrintings(catalog: Database, filters: BinderFilters, ids: unknown[]) {
  const conditions = ['scryfall_id IN (SELECT value FROM json_each(?))']
  const values: (string | number)[] = [JSON.stringify([...new Set(ids)])]
  if (filters.name) {
    conditions.push('instr(lower(name), lower(?)) > 0')
    values.push(filters.name)
  }
  if (filters.typeLine) {
    conditions.push('instr(lower(type_line), lower(?)) > 0')
    values.push(filters.typeLine)
  }
  if (filters.color === 'colorless') {
    conditions.push('json_array_length(colors) = 0')
  } else if (filters.color) {
    conditions.push('EXISTS (SELECT 1 FROM json_each(colors) WHERE value = ?)')
    values.push(filters.color)
  }
  if (filters.manaCost) {
    if (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(filters.manaCost)) {
      conditions.push('mana_value = ?')
      values.push(Number(filters.manaCost))
    } else {
      conditions.push("EXISTS (SELECT 1 FROM json_each(mana_costs) WHERE replace(upper(value), ' ', '') = ?)")
      values.push(filters.manaCost.replace(/\s/g, '').toUpperCase())
    }
  }
  const sets = filters.sets.split(',').map((set) => set.trim()).filter(Boolean)
  if (sets.length) {
    conditions.push(`(${sets.map(() => '(lower(set_code) = lower(?) OR instr(lower(set_name), lower(?)) > 0)').join(' OR ')})`)
    values.push(...sets.flatMap((set) => [set, set]))
  }
  const rows = catalog.selectObjects(
    `SELECT ${cardSummary}, type_line, colors, mana_value, set_name FROM card_printings WHERE ${conditions.join(' AND ')}`,
    values,
  )
  return new Map(rows.map((row) => [row.scryfall_id, row]))
}

function availableFinishes(printing: { foil?: unknown; nonfoil?: unknown }): OwnedFinish[] {
  const finishes: OwnedFinish[] = []
  if (printing.nonfoil) finishes.push('nonfoil')
  if (printing.foil) finishes.push('foil')
  return finishes.length ? finishes : ['unspecified']
}

function printingDetails({ catalog, collection }: Awaited<ReturnType<typeof openCatalog>>, id: string): PrintingDetails {
  const printing = catalog.selectObject(
    'SELECT set_name, legalities, allowed_formats, foil, nonfoil FROM card_printings WHERE scryfall_id = ?', [id],
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
    legalities: printing.legalities == null
      ? Object.fromEntries((JSON.parse(String(printing.allowed_formats ?? '[]')) as string[]).map((format) => [format, 'legal']))
      : JSON.parse(String(printing.legalities)),
    legalitiesComplete: printing.legalities != null,
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
  if (view !== 'binder' || binderFilters || !Number.isSafeInteger(slot) || slot < offset || slot >= offset + binderSpreadCapacity) {
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

function updateSelectedCards(collection: Database, request: Extract<CatalogRequest, { type: 'remove' | 'tag' }>) {
  if (view !== 'binder' || !request.targets.length) throw new Error('Select cards in the binder first.')
  const tag = request.type === 'tag' ? request.tag.trim() : ''
  if (request.type === 'tag' && (!tag || tag.length > 40)) {
    throw new Error('Enter a tag between 1 and 40 characters.')
  }

  collection.transaction(() => {
    if (request.type === 'remove') {
      // Keep the existing spreads even when their last occupied pocket is emptied.
      const spreads = Math.floor(lastBinderSlot(collection) / binderSpreadCapacity) + 1
      collection.exec({
        sql: `INSERT INTO binder_page_reserve (binder, spreads) VALUES (?, ?)
              ON CONFLICT(binder) DO UPDATE SET spreads = max(spreads, excluded.spreads)`,
        bind: [mainBinder, spreads],
      })
    }
    for (const { slot, collectionId } of request.targets) {
      const bind = [collectionId, mainBinder, slot]
      const matches = collection.selectValue(
        'SELECT id FROM collection_entries WHERE id = ? AND binder = ? AND slot = ?', bind,
      )
      if (matches == null) throw new Error('A selected card is no longer in its pocket. Cancel and select the cards again.')
      if (request.type === 'remove') {
        collection.exec({ sql: 'DELETE FROM collection_entries WHERE id = ? AND binder = ? AND slot = ?', bind })
      } else {
        collection.exec({
          sql: 'INSERT INTO collection_tags (collection_id, tag) VALUES (?, ?) ON CONFLICT DO NOTHING',
          bind: [collectionId, tag],
        })
      }
    }
  })
}

function publishResults(db: Awaited<ReturnType<typeof openCatalog>>, edited = false) {
  const capacity = view === 'binder' ? binderSpreadCapacity : binderSpreadSize
  const offset = activePage * capacity
  let matchCount: number | null = null
  let rows
  if (view === 'catalog') {
    rows = catalogRows(db.catalog, offset)
  } else {
    let result = collectionRows(db, offset)
    if (binderFilters) {
      matchCount = result.matchCount
      const lastPage = Math.max(0, Math.ceil(matchCount / capacity) - 1)
      if (activePage > lastPage) {
        activePage = lastPage
        result = collectionRows(db, activePage * capacity)
      }
    }
    rows = result.rows
  }
  const lastSlot = lastBinderSlot(db.collection)
  const reservedSpreads = Number(db.collection.selectValue(
    'SELECT spreads FROM binder_page_reserve WHERE binder = ?', [mainBinder],
  ) ?? 1)
  self.postMessage({
    type: 'results',
    view, languages, edited, lastSlot, reservedSpreads,
    rows: rows.slice(0, capacity),
    page: activePage,
    hasMore: matchCount !== null ? (activePage + 1) * capacity < matchCount
      : view === 'binder' || rows.length > binderSpreadSize,
    matchCount, binderMetadataReady,
    binderTags: view === 'binder' ? db.collection.selectObjects(
      `SELECT min(tag COLLATE BINARY) AS tag FROM collection_tags
       JOIN collection_entries ON collection_entries.id = collection_id
       WHERE binder = ? AND slot IS NOT NULL GROUP BY collection_tags.tag COLLATE NOCASE
       ORDER BY min(tag COLLATE BINARY) COLLATE NOCASE`, [mainBinder],
    ).map((row) => String(row.tag)) : [],
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
    if (force || !binderMetadataReady || !legalitiesReady || typeof localVersion !== 'string' || Date.parse(localVersion) < Date.parse(source.updated_at)) {
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
    if (data.type === 'filter-binder') {
      if (view !== 'binder') throw new Error('Open the binder before applying filters.')
      if (!binderFilters) customBinderPage = activePage
      binderFilters = Object.values(data.filters).some(Boolean) ? data.filters : null
      activePage = binderFilters ? 0 : customBinderPage
      publishResults(db)
      return
    }
    if (data.type === 'remove' || data.type === 'tag') {
      updateSelectedCards(db.collection, data)
      publishResults(db, true)
      return
    }
    if (data.type === 'place' || data.type === 'move') {
      editBinder(db, data)
      publishResults(db, true)
      return
    }
    if (data.type === 'load') refreshLanguages(db.catalog)
    if (data.type === 'layout' || data.type === 'load') {
      binderSorting = data.binderSorting ?? defaultBinderSorting
      if (data.type === 'layout' && data.pageSize === undefined) {
        publishResults(db)
        return
      }
      const size = data.pageSize ?? 0
      if (Number.isInteger(size) && size >= 4 && size <= 16) binderSpreadCapacity = size * 2
      reserveNextSpread(db.collection)
      customBinderPage = 0
    }
    if (data.type === 'view') {
      view = data.view
      binderFilters = null
    }
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
