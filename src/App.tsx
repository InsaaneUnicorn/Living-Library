import { Fragment, useEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { binderColumns, binderPageSize, binderPagesPerSpread, binderRows, binderSpreadSize, defaultBinderFilters, defaultFilters, legalityFormatNames } from './binder'
import type { BinderFilters, CatalogFilters, CatalogRequest, OwnedFinish, PrintingDetails, SavedBinder, SelectionTarget, View } from './binder'
import { BinderCover, Settings } from './Settings'
import { defaultPreferences, readActiveBinder, readPreferences, removeImportedPreferences, saveActiveBinder, savePreferences } from './preferences'
import type { Preferences } from './preferences'
import { maxBinderFileSize, parseBinder, serializeBinder } from './binderTransfer'
import type { BinderFile, BinderFileFormat } from './binderTransfer'
import './App.css'

type Printing = {
  id: number
  scryfall_id: string
  name: string
  set_code: string
  collector_number: string
  language: string
  image_uris: string | null
  ownedFinish?: OwnedFinish
  collectionId?: number
  ownedSlot?: number
  tags?: string[]
}

type WorkerResponse =
  | { type: 'binder-export'; format: BinderFileFormat; file: BinderFile }
  | { type: 'results'; rows: Pocket[]; page: number; updatedAt: string | null;
      view: View; languages: string[]; edited: boolean; lastSlot: number; reservedSpreads: number;
      matchCount: number | null; binderMetadataReady: boolean; binderTags: string[];
      activeBinderId: string; binders: SavedBinder[] }
  | { type: 'sync'; message: string }
  | { type: 'details'; scryfallId: string; details: PrintingDetails }
  | { type: 'error'; operation: CatalogRequest['type']; message: string; scryfallId?: string }

type Pocket = Printing | null
type PageTurn = { direction: 'next' | 'previous'; previousCards: Pocket[] }
type Selection = { card: Printing; from: number; finish?: never } | { card: Printing; from?: undefined; finish: OwnedFinish }
type Preview = { card: Printing; details?: PrintingDetails; error?: string }

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' })
const languageLabels: Record<string, string> = {
  zhs: 'Simplified Chinese', zht: 'Traditional Chinese', ph: 'Phyrexian',
  qya: 'Quenya', grc: 'Ancient Greek', he: 'Hebrew', la: 'Latin', sa: 'Sanskrit',
}

function cardImages(card: Printing, fullSize = false): string[] {
  if (!card.image_uris) return []
  try {
    const images = JSON.parse(card.image_uris)
    const faces = Array.isArray(images) ? images : [images]
    return faces.map((face) => (fullSize ? face?.large : undefined) ?? face?.normal ?? face?.small)
      .filter((url): url is string => typeof url === 'string')
  } catch {
    return []
  }
}

const finishLabels: Record<OwnedFinish, string> = { nonfoil: 'Nonfoil', foil: 'Foil', unspecified: 'Unspecified' }
const legalityLabels: Record<string, string> = {
  legal: 'Legal', restricted: 'Restricted', banned: 'Banned', not_legal: 'Not legal',
}

function SideDrawer({ id, title, drawerRef, children }: {
  id: string
  title: string
  drawerRef: RefObject<HTMLDialogElement | null>
  children: ReactNode
}) {
  return <>
    <button className="drawer-tab" type="button" aria-haspopup="dialog" aria-controls={id}
      onClick={() => drawerRef.current?.showModal()}>
      {title} <span aria-hidden="true">›</span>
    </button>
    <dialog id={id} className="side-drawer" ref={drawerRef} aria-labelledby={`${id}-title`}
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close()
      }}>
      <header>
        <h2 id={`${id}-title`}>{title}</h2>
        <button type="button" className="drawer-close" aria-label={`Close ${title}`} autoFocus
          onClick={() => drawerRef.current?.close()}>×</button>
      </header>
      {children}
    </dialog>
  </>
}

function PlayableInFilter({ value, onChange }: { value: string; onChange: (format: string) => void }) {
  return <label>Playable in <select value={value} onChange={(event) => onChange(event.target.value)}>
    <option value="">Any format</option>
    {Object.entries(legalityFormatNames).map(([format, name]) =>
      <option key={format} value={format}>{name}</option>)}
  </select></label>
}

function CardLegalities({ details }: { details: PrintingDetails }) {
  const groups = new Map<string, string[]>()
  for (const [format, status] of Object.entries(details.legalities)) {
    const name = legalityFormatNames[format] ?? format.replaceAll('_', ' ')
    const names = groups.get(status) ?? []
    groups.set(status, [...names, name])
  }
  const statuses = [...new Set([...Object.keys(legalityLabels), ...groups.keys()])]

  return (
    <>
      <h3>Format legalities</h3>
      {groups.size > 0 ? <dl>
        {statuses.filter((status) => groups.has(status)).map((status) => (
          <Fragment key={status}>
            <dt>{legalityLabels[status] ?? status.replaceAll('_', ' ')}</dt>
            <dd>{groups.get(status)?.sort((a, b) => a.localeCompare(b)).join(', ')}</dd>
          </Fragment>
        ))}
      </dl> : <p>No legality data available.</p>}
      {!details.legalitiesComplete && <p>Refresh Catalog to see all legality statuses.</p>}
    </>
  )
}

function CardPreview({ preview, onClose, onAdd }: {
  preview: Preview
  onClose: () => void
  onAdd: (finish: OwnedFinish) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [finish, setFinish] = useState<OwnedFinish | null>(null)
  const [face, setFace] = useState(0)
  const { card, details, error } = preview
  const images = cardImages(card, true)
  const selectedFinish = finish ?? details?.finishes[0]
  useEffect(() => { dialog.current?.showModal() }, [])

  return (
    <dialog className="settings-dialog card-preview" ref={dialog} aria-labelledby="card-preview-title" onClose={onClose}>
      <header className="card-preview-header">
        <h2 id="card-preview-title">{card.name}</h2>
        <button type="button" className="card-preview-close" aria-label="Close card preview" onClick={onClose}>
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <div className="card-preview-content">
        <div className="card-preview-art">
          <div className="card-preview-image">
            <span>Image unavailable</span>
            {images[face] && <img key={images[face]} src={images[face]} alt={`${card.name}, face ${face + 1}`}
              crossOrigin="anonymous" onError={(event) => { event.currentTarget.hidden = true }} />}
          </div>
          {images.length > 1 && <button type="button" onClick={() => setFace((face + 1) % images.length)}>
            Show other face ({face + 1}/{images.length})
          </button>}
        </div>
        <div className="card-preview-details">
          <dl>
            <dt>Set</dt><dd>{details?.setName ?? card.set_code.toUpperCase()}</dd>
            <dt>Collector number</dt><dd>{card.collector_number}</dd>
            <dt>Language</dt><dd>{languageLabels[card.language] ?? languageNames.of(card.language) ?? card.language}</dd>
          </dl>
          {details && <>
            <CardLegalities details={details} />
            <p><strong>You own {details.owned} {details.owned === 1 ? 'copy' : 'copies'} of this printing.</strong></p>
            <p>{details.ownedNonfoil} nonfoil · {details.ownedFoil} foil</p>
            <label className="preview-finish">Finish to add <select value={selectedFinish}
              onChange={(event) => setFinish(event.target.value as OwnedFinish)}>
              {details.finishes.map((value) => <option key={value} value={value}>{finishLabels[value]}</option>)}
            </select></label>
          </>}
          {error && <p role="alert">{error}</p>}
          {!details && !error && <p role="status">Loading printing details…</p>}
        </div>
      </div>
      <div className="settings-actions">
        <button type="button" disabled={!selectedFinish} onClick={() => {
          if (selectedFinish) onAdd(selectedFinish)
        }}>Add to Binder</button>
      </div>
    </dialog>
  )
}

function BinderSheet({ cards, onPocket, selectedPocket, multiSelected, allowEmpty, disabled, pageNumber,
  rows = binderRows, columns = binderColumns }: {
  cards: Pocket[]
  onPocket?: (index: number, card: Pocket) => void
  selectedPocket?: number
  multiSelected?: (index: number) => boolean
  allowEmpty?: boolean
  disabled?: boolean
  pageNumber?: number
  rows?: number
  columns?: number
}) {
  return (
    <div className="binder-sheet" role={pageNumber ? 'group' : undefined}
      aria-label={pageNumber ? `Page ${pageNumber}` : undefined}>
      {Array.from({ length: rows }, (_, row) => (
        <div className="binder-row" key={row}>
          {Array.from({ length: columns }, (_, column) => {
            const index = row * columns + column
            const card = cards[index] ?? null
            const image = card ? cardImages(card)[0] : undefined
            const isFoil = card?.ownedFinish === 'foil'
            const tags = card?.tags?.join(', ')
            const printing = card?.set_code
              ? `${card.set_code.toUpperCase()} #${card.collector_number} · ${card.language.toUpperCase()}` : ''
            return (
              <figure className="card-pocket" key={column} title={card ? `${card.name} · ${printing}${tags ? ` · Tags: ${tags}` : ''}` : undefined}>
                {card && <figcaption><strong>{card.name}</strong><small>{printing}</small></figcaption>}
                {image && <img key={image} src={image} alt="" loading="lazy" crossOrigin="anonymous"
                  onError={(event) => { event.currentTarget.hidden = true }} />}
                {isFoil && <span className="foil-badge">Foil</span>}
                {tags && <span className="pocket-tags" aria-hidden="true">{tags}</span>}
                {onPocket && (card || allowEmpty) && <button type="button" className="pocket-control" disabled={disabled}
                  aria-label={card ? `${card.name} ${printing}${isFoil ? ', foil' : ''}, pocket ${index + 1}${tags ? `, tags: ${tags}` : ''}` : `Empty pocket ${index + 1}`}
                  aria-pressed={multiSelected ? multiSelected(index) : selectedPocket === index || undefined}
                  onClick={() => onPocket(index, card)}>
                  {!card && <span aria-hidden="true">+</span>}
                </button>}
              </figure>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function sheetCards(cards: Pocket[], side: number, pageSize: number) {
  return cards.slice(side * pageSize, (side + 1) * pageSize)
}

function downloadBinder(file: BinderFile, format: BinderFileFormat) {
  const url = URL.createObjectURL(new Blob([serializeBinder(file, format)], {
    type: format === 'json' ? 'application/json' : 'text/csv;charset=utf-8',
  }))
  const link = document.createElement('a')
  const filename = file.name.replace(/[<>:"/\\|?*\p{Cc}]/gu, '_').replace(/[. ]+$/, '') || 'binder'
  link.href = url
  link.download = `binder-${filename}.${format}`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

function App() {
  const workerRef = useRef<Worker | null>(null)
  const binderDrawer = useRef<HTMLDialogElement>(null)
  const filterDrawer = useRef<HTMLDialogElement>(null)
  const importInput = useRef<HTMLInputElement>(null)
  const pendingImport = useRef<string | null>(null)
  const pendingTurn = useRef<(PageTurn & { page: number }) | null>(null)
  const [cards, setCards] = useState<Pocket[]>([])
  const [workerBusy, setBusy] = useState(true)
  const [readingImport, setReadingImport] = useState(false)
  const busy = workerBusy || readingImport
  const [error, setError] = useState('')
  const [transferStatus, setTransferStatus] = useState('')
  const [view, setView] = useState<View>('catalog')
  const [filters, setFilters] = useState(defaultFilters)
  const [binderFilterDraft, setBinderFilterDraft] = useState(defaultBinderFilters)
  const [binderTags, setBinderTags] = useState<string[]>([])
  const [matchCount, setMatchCount] = useState<number | null>(null)
  const [binderMetadataReady, setBinderMetadataReady] = useState(false)
  const [languages, setLanguages] = useState<string[]>([])
  const [selection, setSelection] = useState<Selection | null>(null)
  const [selectedCards, setSelectedCards] = useState<SelectionTarget[] | null>(null)
  const [tagName, setTagName] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [binderId, setBinderId] = useState(readActiveBinder)
  const acknowledgedBinder = useRef(binderId)
  const [binders, setBinders] = useState<SavedBinder[]>([])
  const activeBinder = binders.find((binder) => binder.id === binderId)
  const binderActionsDisabled = busy || !activeBinder
  const [binderNameForm, setBinderNameForm] = useState<'create' | 'rename' | null>(null)
  const [binderName, setBinderName] = useState('')
  const [preferences, setPreferences] = useState(() => readPreferences(binderId))
  const initialLoad = useRef<Extract<CatalogRequest, { type: 'load' }>>({
    type: 'load', binderId, pageSize: preferences.rows * preferences.columns, binderSorting: preferences.binderSorting,
  })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [cover, setCover] = useState<'front' | 'back' | null>(null)
  const [lastSlot, setLastSlot] = useState(-1)
  const [reservedSpreads, setReservedSpreads] = useState(1)
  const [page, setPage] = useState(0)
  const [turn, setTurn] = useState<PageTurn | null>(null)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [syncStatus, setSyncStatus] = useState('')
  const [syncError, setSyncError] = useState('')

  useEffect(() => {
    const worker = new Worker(new URL('./db.worker.ts', import.meta.url), { type: 'module' })
    let databaseLoaded = false
    workerRef.current = worker
    worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      if (data.type === 'results') {
        const requestedTurn = pendingTurn.current
        setTurn(requestedTurn?.page === data.page && !window.matchMedia('(prefers-reduced-motion: reduce), (max-width: 35rem)').matches
          ? requestedTurn
          : null)
        pendingTurn.current = null
        setCards(data.rows)
        setBinders(data.binders)
        if (data.activeBinderId === pendingImport.current) {
          pendingImport.current = null
          setTransferStatus('Binder imported.')
        }
        if (data.activeBinderId !== acknowledgedBinder.current) {
          acknowledgedBinder.current = data.activeBinderId
          setBinderId(data.activeBinderId)
          setPreferences(readPreferences(data.activeBinderId))
          saveActiveBinder(data.activeBinderId)
        }
        setView(data.view)
        setLanguages(data.languages)
        setLastSlot(data.lastSlot)
        setReservedSpreads(data.reservedSpreads)
        if (data.edited) {
          setSelection(null)
          setSelectedCards(null)
        }
        setMatchCount(data.matchCount)
        setBinderMetadataReady(data.binderMetadataReady)
        setBinderTags(data.binderTags)
        setPage(data.page)
        setUpdatedAt(data.updatedAt)
        setBusy(false)
        if (!databaseLoaded) {
          databaseLoaded = true
          checkForUpdates()
        }
      } else if (data.type === 'binder-export') {
        try {
          downloadBinder(data.file, data.format)
          setTransferStatus(`Binder exported as ${data.format.toUpperCase()}.`)
        } catch {
          setError('The binder file could not be downloaded.')
        }
        setBusy(false)
      } else if (data.type === 'details') {
        setPreview((current) => current?.card.scryfall_id === data.scryfallId
          ? { ...current, details: data.details } : current)
      } else if (data.type === 'sync') {
        setSyncError('')
        setSyncStatus(data.message)
      } else if (data.operation === 'sync') {
        setSyncError(data.message)
        setSyncStatus('')
      } else if (data.operation === 'details') {
        setPreview((current) => current && current.card.scryfall_id === data.scryfallId
          ? { ...current, error: data.message } : current)
      } else {
        if (data.operation === 'import-binder' && pendingImport.current) {
          removeImportedPreferences(pendingImport.current)
          pendingImport.current = null
        }
        pendingTurn.current = null
        setError(data.message)
        setBusy(false)
      }
    }
    worker.onerror = (event) => {
      setError(event.message || 'The database worker could not start.')
      setBusy(false)
      setSyncStatus('')
    }
    worker.postMessage(initialLoad.current)
    function checkForUpdates() {
      if (databaseLoaded && navigator.onLine) worker.postMessage({ type: 'sync' })
    }
    window.addEventListener('online', checkForUpdates)
    return () => {
      window.removeEventListener('online', checkForUpdates)
      workerRef.current = null
      worker.terminate()
    }
  }, [])

  function requestPrintings(request: Exclude<CatalogRequest, { type: 'load' | 'sync' | 'details' }>) {
    const worker = workerRef.current
    if (!worker || busy || !activeBinder) return
    pendingTurn.current = request.type === 'page'
      ? { page: request.page, direction: request.page > page ? 'next' : 'previous', previousCards: cards }
      : null
    setBusy(true)
    setError('')
    worker.postMessage(request)
  }

  async function importBinderFile(file: File | undefined) {
    const worker = workerRef.current
    if (!file || !worker || busy) return
    setReadingImport(true)
    setError('')
    setTransferStatus('')
    try {
      if (file.size > maxBinderFileSize) throw new Error('Choose a binder file smaller than 10 MB.')
      const extension = file.name.split('.').pop()?.toLowerCase()
      if (extension !== 'json' && extension !== 'csv') throw new Error('Choose a JSON or CSV binder file.')
      const imported = parseBinder(await file.text(), extension)
      const id = crypto.randomUUID()
      try {
        savePreferences(imported.preferences, id)
      } catch {
        throw new Error('There is not enough local storage to save this binder’s settings.')
      }
      pendingImport.current = id
      setCover(null)
      setTurn(null)
      setBinderNameForm(null)
      setBinderFilterDraft(defaultBinderFilters)
      requestPrintings({ type: 'import-binder', binderId: id, file: imported })
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The binder could not be imported.')
    } finally {
      setReadingImport(false)
    }
  }

  const rows = view === 'binder' ? preferences.rows : binderRows
  const columns = view === 'binder' ? preferences.columns : binderColumns
  const pageSize = view === 'binder' ? rows * columns : binderPageSize
  const spreadSize = view === 'binder' ? pageSize * binderPagesPerSpread : binderSpreadSize
  const spreadCount = Math.max(preferences.spreads, reservedSpreads, Math.floor(lastSlot / spreadSize) + 1)
  const filteredBinder = view === 'binder' && matchCount !== null
  const customBinder = view === 'binder' && !filteredBinder
  const totalBinderPages = spreadCount * binderPagesPerSpread
  const totalResultPages = Math.ceil((matchCount ?? 0) / spreadSize)
  const resultsRange = matchCount
    ? `${page * spreadSize + 1}–${Math.min((page + 1) * spreadSize, matchCount)} of ${matchCount}`
    : ''
  const pageLabel = customBinder
    ? cover
      ? `${cover === 'front' ? 'Front cover' : 'Back cover'} · ${totalBinderPages} pages`
      : `Pages ${page * binderPagesPerSpread + 1}–${(page + 1) * binderPagesPerSpread} of ${totalBinderPages}`
    : totalResultPages ? `Page ${page + 1} of ${totalResultPages}` : '0 pages'
  const canGoPrevious = customBinder ? cover !== 'front' : page > 0
  const canGoNext = customBinder ? cover !== 'back' : page + 1 < totalResultPages
  const jumpPageCount = customBinder ? totalBinderPages : totalResultPages

  function turnPage(direction: 'next' | 'previous') {
    if (busy || turn || (direction === 'next' ? !canGoNext : !canGoPrevious)) return
    if (customBinder) {
      if (cover) {
        setCover(null)
        return
      }
      if (direction === 'previous' && page === 0) {
        setCover('front')
        return
      }
      if (direction === 'next' && page >= spreadCount - 1) {
        setCover('back')
        return
      }
    }
    requestPrintings({ type: 'page', page: page + (direction === 'next' ? 1 : -1) })
  }

  const sourceSide = turn?.direction === 'next' ? 1 : 0
  const destinationSide = 1 - sourceSide

  function changeView(nextView: View) {
    if (busy || view === nextView) return
    setCover(null)
    setSelection(null)
    setSelectedCards(null)
    setBinderFilterDraft(defaultBinderFilters)
    requestPrintings({ type: 'view', view: nextView })
  }

  function openBinder(request: Extract<CatalogRequest, { type: 'create-binder' | 'switch-binder' }>) {
    if (busy) return
    setCover(null)
    setTurn(null)
    setSelectedCards(null)
    setSelection((current) => current?.from === undefined ? current : null)
    setBinderFilterDraft(defaultBinderFilters)
    requestPrintings(request)
  }

  function applyBinderFilters(filters: BinderFilters) {
    setCover(null)
    setTurn(null)
    setSelectedCards(null)
    requestPrintings({ type: 'filter-binder', filters: {
      query: filters.query.trim(),
      typeLine: filters.typeLine.trim(),
      color: filters.color,
      manaCost: filters.manaCost.trim(),
      sets: filters.sets.split(',').map((set) => set.trim()).filter(Boolean).join(','),
      legalIn: filters.legalIn,
      tag: filters.tag,
      tagOrder: filters.tagOrder,
    } })
  }

  function applySettings(next: Preferences) {
    savePreferences(next, binderId)
    const layoutChanged = next.rows !== preferences.rows || next.columns !== preferences.columns
    setPreferences(next)
    setSettingsOpen(false)
    if (layoutChanged) {
      setCover(null)
      setSelection(null)
      setSelectedCards(null)
    }
    if (layoutChanged || next.binderSorting !== preferences.binderSorting) {
      requestPrintings({ type: 'layout', pageSize: layoutChanged ? next.rows * next.columns : undefined,
        binderSorting: next.binderSorting })
    }
  }

  function addSpread() {
    const next = { ...preferences, spreads: spreadCount + 1 }
    try {
      savePreferences(next, binderId)
    } catch {
      setError('The new spread could not be saved on this device.')
      return
    }
    setPreferences(next)
    setCover(null)
    requestPrintings({ type: 'page', page: spreadCount })
  }

  function openPrintingPreview(card: Printing) {
    const worker = workerRef.current
    if (!worker) return
    setPreview({ card })
    const request: CatalogRequest = { type: 'details', scryfallId: card.scryfall_id }
    worker.postMessage(request)
  }

  function choosePocket(slot: number, card: Pocket) {
    if (view === 'catalog' || (filteredBinder && selectedCards === null)) {
      if (card) openPrintingPreview(card)
      return
    }
    if (selectedCards !== null) {
      const collectionId = card?.collectionId
      if (collectionId === undefined) return
      setSelectedCards((current) => {
        if (current === null) return current
        return current.some((target) => target.slot === slot)
          ? current.filter((target) => target.slot !== slot)
          : [...current, { slot, collectionId }]
      })
      return
    }
    if (!selection) {
      if (card) setSelection({ card, from: slot })
      return
    }
    if (selection.from === slot) {
      setSelection(null)
      return
    }
    requestPrintings(selection.from === undefined
      ? { type: 'place', scryfallId: selection.card.scryfall_id, slot, finish: selection.finish }
      : { type: 'move', from: selection.from, slot })
  }

  function removeSelectedCard() {
    if (selection?.from === undefined || selection.card.collectionId === undefined) return
    if (!window.confirm(`Remove ${selection.card.name} from the binder?`)) return
    requestPrintings({ type: 'remove', targets: [{ slot: selection.from, collectionId: selection.card.collectionId }] })
  }

  function removeSelectedCards() {
    if (!selectedCards?.length) return
    const count = selectedCards.length
    if (!window.confirm(`Remove ${count} selected ${count === 1 ? 'card' : 'cards'} from the binder?`)) return
    requestPrintings({ type: 'remove', targets: selectedCards })
  }

  return (
    <div className="library-app" data-site-theme={preferences.siteTheme}>
      <nav className="catalog-nav" aria-label="Catalog controls">
        <h1>Living Library</h1>
        <button type="button" aria-pressed={view === 'catalog'} disabled={binderActionsDisabled}
          onClick={() => changeView('catalog')}>Show Card Catalog</button>
        <button type="button" aria-pressed={view === 'binder'} disabled={binderActionsDisabled}
          onClick={() => changeView('binder')}>Show Binder</button>
        <button type="button" disabled={busy} onClick={() => setSettingsOpen(true)}>Settings</button>
        <form id="card-search" role="search" onSubmit={(event) => {
          event.preventDefault()
          if (view === 'catalog') requestPrintings({ type: 'search', filters })
          else if (!busy && !selection) applyBinderFilters(binderFilterDraft)
        }}>
          <input type="search" aria-label="Search by card name or Scryfall ID" placeholder="Card name or Scryfall ID"
            value={view === 'catalog' ? filters.query : binderFilterDraft.query} onChange={(event) => {
              const query = event.target.value
              if (view === 'catalog') setFilters({ ...filters, query })
              else setBinderFilterDraft({ ...binderFilterDraft, query })
            }} />
          <button type="submit" disabled={binderActionsDisabled || Boolean(selection)}>Search</button>
        </form>
        <button type="button" disabled={busy || Boolean(syncStatus)} onClick={() => {
          const worker = workerRef.current
          if (!worker) return
          if (!activeBinder) {
            setBusy(true)
            setError('')
            worker.postMessage(initialLoad.current)
          } else if (navigator.onLine) worker.postMessage({ type: 'sync' })
          else setSyncError('Connect to the internet to check for catalog updates.')
        }}>
          {activeBinder || busy ? 'Refresh Catalog' : 'Retry Local Database'}
        </button>
      </nav>
      <main className="catalog-main">
        <SideDrawer id="binder-drawer" title="My Binders" drawerRef={binderDrawer}>
          <div className="catalog-filters binder-manager">
            <label>Active binder <select aria-label="Binder" value={activeBinder ? binderId : ''}
              disabled={binderActionsDisabled} onChange={(event) => {
              const id = event.target.value
              const { rows, columns, binderSorting } = readPreferences(id)
              setBinderNameForm(null)
              openBinder({ type: 'switch-binder', binderId: id, pageSize: rows * columns, binderSorting })
              binderDrawer.current?.close()
            }}>
              {!activeBinder && <option value="">{workerBusy ? 'Loading binders…' : 'Binders unavailable'}</option>}
              {binders.map(({ id, name }) => <option value={id} key={id}>{name}</option>)}
            </select></label>
            <button type="button" disabled={binderActionsDisabled} onClick={() => {
              setBinderName('')
              setBinderNameForm('create')
            }}>New Binder</button>
            <button type="button" disabled={binderActionsDisabled} onClick={() => {
              setBinderName(activeBinder?.name ?? '')
              setBinderNameForm('rename')
            }}>Rename Binder</button>
            {(['json', 'csv'] as const).map((format) => (
              <button key={format} type="button" disabled={binderActionsDisabled} onClick={() => {
                setTransferStatus('')
                requestPrintings({ type: 'export-binder', binderId, format, preferences })
              }}>Export {format.toUpperCase()}</button>
            ))}
            <button type="button" disabled={binderActionsDisabled} onClick={() => importInput.current?.click()}>Import Binder</button>
            <input ref={importInput} type="file" accept=".json,.csv,application/json,text/csv" hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ''
                void importBinderFile(file)
              }} />
            {transferStatus && <p role="status">{transferStatus}</p>}
            {error && <p role="alert">{error}</p>}
            {binderNameForm && <form className="catalog-filters binder-name-form" onSubmit={(event) => {
              event.preventDefault()
              const name = binderName.trim()
              if (busy || !name) return
              if (binderNameForm === 'create') {
                const { rows, columns, binderSorting } = defaultPreferences
                openBinder({ type: 'create-binder', name, pageSize: rows * columns, binderSorting })
                binderDrawer.current?.close()
              } else {
                requestPrintings({ type: 'rename-binder', name })
              }
              setBinderNameForm(null)
            }}>
              <label>Binder name <input autoFocus value={binderName} required maxLength={60}
                onChange={(event) => setBinderName(event.target.value)} /></label>
              <button type="submit" disabled={busy || !binderName.trim()}>
                {binderNameForm === 'create' ? 'Create Binder' : 'Save Name'}
              </button>
              <button type="button" onClick={() => setBinderNameForm(null)}>Cancel</button>
            </form>}
          </div>
        </SideDrawer>
        <SideDrawer id="filter-drawer" title="Filters" drawerRef={filterDrawer}>
          {view === 'catalog' && <form className="catalog-filters" aria-label="Catalog filters" onSubmit={(event) => {
            event.preventDefault()
            if (busy) return
            requestPrintings({ type: 'search', filters })
            filterDrawer.current?.close()
          }}>
            <details className="language-filter">
              <summary>Languages{filters.languages.length ? ` (${filters.languages.length})` : ''}</summary>
              <div className="language-options">
                {languages.map((language) => (
                  <label key={language}>
                    <input type="checkbox" checked={filters.languages.includes(language)} onChange={(event) => {
                      const selected = event.target.checked
                      setFilters((current) => ({ ...current, languages: selected
                        ? [...current.languages, language]
                        : current.languages.filter((item) => item !== language) }))
                    }} />
                    {languageLabels[language] ?? languageNames.of(language) ?? language}
                  </label>
                ))}
                {!languages.length && <span>Languages appear after the catalog loads.</span>}
              </div>
            </details>
            <label>Set <input placeholder="Name or code" value={filters.set}
              onChange={(event) => setFilters({ ...filters, set: event.target.value })} /></label>
            <button type="button" disabled={busy} onClick={() => {
              const next = { ...filters, set: 'Secret Lair' }
              setFilters(next)
              requestPrintings({ type: 'search', filters: next })
              filterDrawer.current?.close()
            }}>Secret Lair Printings</button>
            <PlayableInFilter value={filters.legalIn}
              onChange={(legalIn) => setFilters({ ...filters, legalIn })} />
            <label>Finish <select value={filters.finish} onChange={(event) => {
              setFilters({ ...filters, finish: event.target.value as CatalogFilters['finish'] })
            }}>
              <option value="">Any finish</option>
              <option value="foil">Foil available</option>
              <option value="nonfoil">Nonfoil available</option>
            </select></label>
            <label>Sort by <select value={filters.sort} onChange={(event) => {
              setFilters({ ...filters, sort: event.target.value as CatalogFilters['sort'] })
            }}>
              <option value="name">Name (A–Z)</option>
              <option value="name-desc">Name (Z–A)</option>
              <option value="set">Set and collector number</option>
            </select></label>
            <div className="filter-actions">
              <button type="submit" disabled={busy}>Apply Filters</button>
              <button type="button" disabled={busy} onClick={() => {
                setFilters(defaultFilters)
                requestPrintings({ type: 'search', filters: defaultFilters })
                filterDrawer.current?.close()
              }}>Clear</button>
            </div>
          </form>}
          {view === 'binder' && <form className="catalog-filters" aria-label="Binder filters" onSubmit={(event) => {
            event.preventDefault()
            if (busy || selection) return
            applyBinderFilters(binderFilterDraft)
            filterDrawer.current?.close()
          }}>
            <label>Card type <input placeholder="e.g. Creature" value={binderFilterDraft.typeLine}
              onChange={(event) => setBinderFilterDraft({ ...binderFilterDraft, typeLine: event.target.value })} /></label>
            <label>Mana color <select value={binderFilterDraft.color}
              onChange={(event) => setBinderFilterDraft({ ...binderFilterDraft, color: event.target.value })}>
              <option value="">Any color</option>
              <option value="W">White</option>
              <option value="U">Blue</option>
              <option value="B">Black</option>
              <option value="R">Red</option>
              <option value="G">Green</option>
              <option value="colorless">Colorless</option>
            </select></label>
            <label>Mana cost <input placeholder="e.g. {2}{U} or 3" value={binderFilterDraft.manaCost}
              onChange={(event) => setBinderFilterDraft({ ...binderFilterDraft, manaCost: event.target.value })} /></label>
            <label>Sets <input placeholder="Names or codes" maxLength={250} value={binderFilterDraft.sets}
              aria-describedby="binder-set-hint"
              onChange={(event) => setBinderFilterDraft({ ...binderFilterDraft, sets: event.target.value })} /></label>
            <span id="binder-set-hint">Separate sets with commas.</span>
            <PlayableInFilter value={binderFilterDraft.legalIn}
              onChange={(legalIn) => setBinderFilterDraft({ ...binderFilterDraft, legalIn })} />
            <label>Tag <select value={binderFilterDraft.tag}
              onChange={(event) => setBinderFilterDraft({ ...binderFilterDraft, tag: event.target.value })}>
              <option value="">Any tag</option>
              {binderFilterDraft.tag && !binderTags.includes(binderFilterDraft.tag) &&
                <option value={binderFilterDraft.tag}>{binderFilterDraft.tag}</option>}
              {binderTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
            </select></label>
            <label>Sort by <select value={binderFilterDraft.tagOrder} onChange={(event) => {
              const tagOrder = event.target.value as BinderFilters['tagOrder']
              setBinderFilterDraft({ ...binderFilterDraft, tagOrder })
            }}>
              <option value="">Pocket order</option>
              <option value="asc">Tag (A–Z)</option>
              <option value="desc">Tag (Z–A)</option>
              <option value="priorities">Settings priorities</option>
            </select></label>
            <div className="filter-actions">
              <button type="submit" disabled={busy || Boolean(selection)}>Apply Filters</button>
              <button type="button" disabled={busy || Boolean(selection)} onClick={() => {
                setBinderFilterDraft(defaultBinderFilters)
                applyBinderFilters(defaultBinderFilters)
                filterDrawer.current?.close()
              }}>Custom Layout</button>
            </div>
          </form>}
        </SideDrawer>
        <div className="catalog-status">
          {syncStatus && <p role="status">{syncStatus}</p>}
          {syncError && <p role="alert">Catalog update failed. {syncError}</p>}
          {updatedAt && <p>Catalog updated {new Date(updatedAt).toLocaleString()}</p>}
          {view === 'catalog' && activeBinder && !busy && !updatedAt && !syncStatus && !syncError && (
            <p>No catalog has been downloaded to this browser yet.</p>
          )}
          {error && <p role="alert">{error}</p>}
          {view === 'binder' && !binderMetadataReady && !syncStatus &&
            <p>Use Refresh Catalog to load card type, color, and mana cost data.</p>}
          <p role="status">
            {busy ? 'Loading…' : !activeBinder ? null : view === 'catalog'
              ? (resultsRange ? `Showing printings ${resultsRange}` : 'No matching printings.')
              : filteredBinder ? (resultsRange ? `Showing cards ${resultsRange}` : 'No matching binder cards.')
              : selectedCards ? 'Select cards on any binder page.' : 'Select a card to move it, or use Select Cards for multiple cards.'}
          </p>
        </div>
        {view === 'binder' && selection && <div className="binder-selection">
          <p role="status">{selection.from === undefined ? 'Choose an empty pocket for' : 'Choose a pocket to move or swap'} <strong>{selection.card.name}</strong>{(selection.finish ?? selection.card.ownedFinish) === 'foil' ? ' (foil)' : ''}.</p>
          {selection.from === undefined && <span>{selection.card.set_code.toUpperCase()} #{selection.card.collector_number}</span>}
          <button type="button" disabled={busy || Boolean(turn)} onClick={addSpread}>Add Pages</button>
          {selection.from !== undefined && !cover && Math.floor(selection.from / spreadSize) === page &&
            <>
              <button type="button" disabled={busy || Boolean(turn)} onClick={() => openPrintingPreview(selection.card)}>Card Details</button>
              <button type="button" disabled={busy || Boolean(turn)} onClick={() => {
                if (selection.card.collectionId === undefined) return
                setTagName('')
                setSelectedCards([{ slot: selection.from, collectionId: selection.card.collectionId }])
                setSelection(null)
              }}>Tag Card</button>
              <button type="button" disabled={busy || Boolean(turn)} onClick={removeSelectedCard}>Remove Card</button>
            </>}
          <button type="button" disabled={busy} onClick={() => setSelection(null)}>Cancel</button>
        </div>}
        {view === 'binder' && selectedCards && <form className="binder-selection" onSubmit={(event) => {
          event.preventDefault()
          if (turn || !selectedCards.length || !tagName.trim()) return
          requestPrintings({ type: 'tag', targets: selectedCards, tag: tagName.trim() })
        }}>
          <p role="status">{selectedCards.length} selected</p>
          <label>Tag <input value={tagName} maxLength={40} disabled={busy}
            onChange={(event) => setTagName(event.target.value)} /></label>
          <button type="submit" disabled={busy || Boolean(turn) || !selectedCards.length || !tagName.trim()}>Add Tag</button>
          <button type="button" disabled={busy || Boolean(turn) || !selectedCards.length}
            onClick={removeSelectedCards}>Remove Selected</button>
          <button type="button" disabled={busy} onClick={() => setSelectedCards(null)}>Cancel</button>
        </form>}
        <nav className="page-controls" aria-label={customBinder ? 'Binder pages' : 'Result pages'}>
          <button type="button" disabled={busy || Boolean(turn) || !canGoPrevious} onClick={() => turnPage('previous')}>
            <span aria-hidden="true">← </span>Previous
          </button>
          <span aria-live="polite">{pageLabel}</span>
          <button type="button" disabled={busy || Boolean(turn) || !canGoNext} onClick={() => turnPage('next')}>
            Next<span aria-hidden="true"> →</span>
          </button>
          {jumpPageCount > 0 && <form className="page-jump" key={`${binderId}:${view}:${customBinder}`} onSubmit={(event) => {
            event.preventDefault()
            if (busy || turn) return
            const pageNumber = Number(new FormData(event.currentTarget).get('page'))
            if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > jumpPageCount) return
            const targetPage = Math.floor((pageNumber - 1) / (customBinder ? binderPagesPerSpread : 1))
            event.currentTarget.reset()
            setCover(null)
            if (targetPage !== page) requestPrintings({ type: 'page', page: targetPage })
          }}>
            <label>Go to page <input name="page" type="number" inputMode="numeric" min={1} max={jumpPageCount}
              required disabled={busy || Boolean(turn)} /></label>
            <button type="submit" disabled={busy || Boolean(turn)}>Go</button>
          </form>}
          {view === 'binder' && !selection && !selectedCards && <>
            {customBinder && <button type="button" disabled={busy || Boolean(turn)} onClick={addSpread}>Add Spread</button>}
            <button type="button" disabled={busy || Boolean(turn) || Boolean(cover) || (filteredBinder && matchCount === 0)}
              onClick={() => {
                setTagName('')
                setSelectedCards([])
              }}>Select Cards</button>
          </>}
        </nav>
        <div className="binder-viewport" aria-label={view === 'binder' ? 'Personal binder' : 'Card catalog'} role="region" tabIndex={0}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            turnPage(event.key === 'ArrowRight' ? 'next' : 'previous')
          }}>
          <div className={cover ? 'binder binder-closed' : 'binder'}
            data-binder-theme={view === 'binder' ? preferences.binderTheme : undefined}
            data-binding={view === 'binder' ? preferences.binding : undefined}>
            {cover ? <BinderCover key={cover} side={cover} preferences={preferences} /> : <>
            {Array.from({ length: binderPagesPerSpread }, (_, side) => (
              <BinderSheet key={side} cards={sheetCards(cards, side, pageSize)} rows={rows} columns={columns} disabled={busy || Boolean(turn)}
                pageNumber={page * binderPagesPerSpread + side + 1} allowEmpty={view === 'binder' && Boolean(selection)}
                selectedPocket={selection?.from === undefined ? undefined : selection.from - page * spreadSize - side * pageSize}
                multiSelected={selectedCards ? (index) => selectedCards.some((target) =>
                  target.collectionId === cards[side * pageSize + index]?.collectionId) : undefined}
                onPocket={(index, card) => choosePocket(card?.ownedSlot ?? page * spreadSize + side * pageSize + index, card)} />
            ))}
            {turn && (
              <>
                <div className="binder-turn-underlay" data-side={destinationSide} aria-hidden="true">
                  <BinderSheet cards={sheetCards(turn.previousCards, destinationSide, pageSize)} rows={rows} columns={columns} />
                </div>
                <div className="binder-turn" data-side={sourceSide} aria-hidden="true"
                  onAnimationEnd={() => setTurn(null)}>
                  <div className="binder-turn-face">
                    <BinderSheet cards={sheetCards(turn.previousCards, sourceSide, pageSize)} rows={rows} columns={columns} />
                  </div>
                  <div className="binder-turn-face binder-turn-back">
                    <BinderSheet cards={sheetCards(cards, destinationSide, pageSize)} rows={rows} columns={columns} />
                  </div>
                </div>
              </>
            )}
            </>}
          </div>
        </div>
      </main>
      {settingsOpen && <Settings preferences={preferences} onSave={applySettings} onClose={() => setSettingsOpen(false)} />}
      {preview && <CardPreview key={preview.card.scryfall_id} preview={preview} onClose={() => setPreview(null)}
        onAdd={(finish) => {
          setSelection({ card: preview.card, finish })
          setCover(null)
          setBinderFilterDraft(defaultBinderFilters)
          setPreview(null)
          requestPrintings({ type: 'view', view: 'binder' })
        }} />}
    </div>
  )
}

export default App
