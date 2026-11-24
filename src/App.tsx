import { useEffect, useRef, useState } from 'react'
import { binderColumns, binderPageSize, binderPagesPerSpread, binderRows, binderSpreadSize, defaultFilters } from './binder'
import type { CatalogFilters, CatalogRequest, OwnedFinish, PrintingDetails, View } from './binder'
import { BinderCover, Settings } from './Settings'
import { readPreferences, savePreferences } from './preferences'
import type { Preferences } from './preferences'
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
}

type WorkerResponse =
  | { type: 'results'; rows: Pocket[]; page: number; hasMore: boolean; updatedAt: string | null;
      view: View; languages: string[]; edited: boolean; lastSlot: number; reservedSpreads: number }
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
            {details && <><dt>Legal formats</dt><dd>{details.formats.join(', ') || 'None listed'}</dd></>}
          </dl>
          {details && <>
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

function BinderSheet({ cards, onPocket, selectedPocket, allowEmpty, disabled, pageNumber,
  rows = binderRows, columns = binderColumns }: {
  cards: Pocket[]
  onPocket?: (index: number, card: Pocket) => void
  selectedPocket?: number
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
            const printing = card?.set_code
              ? `${card.set_code.toUpperCase()} #${card.collector_number} · ${card.language.toUpperCase()}` : ''
            return (
              <figure className="card-pocket" key={column} title={card ? `${card.name} · ${printing}` : undefined}>
                {card && <figcaption><strong>{card.name}</strong><small>{printing}</small></figcaption>}
                {image && <img key={image} src={image} alt="" loading="lazy" crossOrigin="anonymous"
                  onError={(event) => { event.currentTarget.hidden = true }} />}
                {isFoil && <span className="foil-badge">Foil</span>}
                {onPocket && (card || allowEmpty) && <button type="button" className="pocket-control" disabled={disabled}
                  aria-label={card ? `${card.name} ${printing}${isFoil ? ', foil' : ''}, pocket ${index + 1}` : `Empty pocket ${index + 1}`}
                  aria-pressed={selectedPocket === index ? true : undefined}
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

function App() {
  const workerRef = useRef<Worker | null>(null)
  const pendingTurn = useRef<(PageTurn & { page: number }) | null>(null)
  const [cards, setCards] = useState<Pocket[]>([])
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [view, setView] = useState<View>('catalog')
  const [filters, setFilters] = useState(defaultFilters)
  const [languages, setLanguages] = useState<string[]>([])
  const [selection, setSelection] = useState<Selection | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [preferences, setPreferences] = useState(readPreferences)
  const initialPageSize = useRef(preferences.rows * preferences.columns)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [cover, setCover] = useState<'front' | 'back' | null>(null)
  const [lastSlot, setLastSlot] = useState(-1)
  const [reservedSpreads, setReservedSpreads] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [page, setPage] = useState(0)
  const [turn, setTurn] = useState<PageTurn | null>(null)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [syncStatus, setSyncStatus] = useState('')
  const [syncError, setSyncError] = useState('')

  useEffect(() => {
    const worker = new Worker(new URL('./db.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      if (data.type === 'results') {
        const requestedTurn = pendingTurn.current
        setTurn(requestedTurn?.page === data.page && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? requestedTurn
          : null)
        pendingTurn.current = null
        setCards(data.rows)
        setView(data.view)
        setLanguages(data.languages)
        setLastSlot(data.lastSlot)
        setReservedSpreads(data.reservedSpreads)
        if (data.edited) setSelection(null)
        setHasMore(data.hasMore)
        setPage(data.page)
        setUpdatedAt(data.updatedAt)
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
    worker.postMessage({ type: 'load', pageSize: initialPageSize.current })
    function checkForUpdates() {
      if (navigator.onLine) worker.postMessage({ type: 'sync' })
    }
    checkForUpdates()
    window.addEventListener('online', checkForUpdates)
    return () => {
      window.removeEventListener('online', checkForUpdates)
      workerRef.current = null
      worker.terminate()
    }
  }, [])

  function requestPrintings(request: Exclude<CatalogRequest, { type: 'load' | 'sync' | 'details' }>) {
    const worker = workerRef.current
    if (!worker || busy) return
    pendingTurn.current = request.type === 'page'
      ? { page: request.page, direction: request.page > page ? 'next' : 'previous', previousCards: cards }
      : null
    setBusy(true)
    setError('')
    worker.postMessage(request)
  }

  const rows = view === 'binder' ? preferences.rows : binderRows
  const columns = view === 'binder' ? preferences.columns : binderColumns
  const pageSize = view === 'binder' ? rows * columns : binderPageSize
  const spreadSize = view === 'binder' ? pageSize * binderPagesPerSpread : binderSpreadSize
  const spreadCount = Math.max(preferences.spreads, reservedSpreads, Math.floor(lastSlot / spreadSize) + 1)
  const canGoPrevious = view === 'binder' ? cover !== 'front' : page > 0
  const canGoNext = view === 'binder' ? cover !== 'back' : hasMore

  function turnPage(direction: 'next' | 'previous') {
    if (busy || turn || (direction === 'next' ? !canGoNext : !canGoPrevious)) return
    if (view === 'binder') {
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
    requestPrintings({ type: 'view', view: nextView })
  }

  function applySettings(next: Preferences) {
    savePreferences(next)
    const layoutChanged = next.rows !== preferences.rows || next.columns !== preferences.columns
    setPreferences(next)
    setSettingsOpen(false)
    if (layoutChanged) {
      setCover(null)
      setSelection(null)
      requestPrintings({ type: 'layout', pageSize: next.rows * next.columns })
    }
  }

  function addSpread() {
    const next = { ...preferences, spreads: spreadCount + 1 }
    try {
      savePreferences(next)
    } catch {
      setError('The new spread could not be saved on this device.')
      return
    }
    setPreferences(next)
    setCover(null)
    requestPrintings({ type: 'page', page: spreadCount })
  }

  function choosePocket(slot: number, card: Pocket) {
    if (view === 'catalog') {
      if (!card || !workerRef.current) return
      setPreview({ card })
      const request: CatalogRequest = { type: 'details', scryfallId: card.scryfall_id }
      workerRef.current.postMessage(request)
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

  return (
    <div className="library-app" data-site-theme={preferences.siteTheme}>
      <nav className="catalog-nav" aria-label="Catalog controls">
        <h1>Living Library</h1>
        <button type="button" aria-pressed={view === 'catalog'} disabled={busy}
          onClick={() => changeView('catalog')}>Show Card Catalog</button>
        <button type="button" aria-pressed={view === 'binder'} disabled={busy}
          onClick={() => changeView('binder')}>Show Binder</button>
        <button type="button" disabled={busy} onClick={() => setSettingsOpen(true)}>Settings</button>
        {view === 'catalog' && <form id="catalog-search" role="search" onSubmit={(event) => {
          event.preventDefault()
          requestPrintings({ type: 'search', filters })
        }}>
          <input type="search" aria-label="Search by card name" placeholder="Search by card name"
            value={filters.query} onChange={(event) => setFilters({ ...filters, query: event.target.value })} />
          <button type="submit" disabled={busy}>Search</button>
        </form>}
        <button type="button" disabled={busy || Boolean(syncStatus)} onClick={() => {
          if (navigator.onLine) workerRef.current?.postMessage({ type: 'sync', force: true })
          else setSyncError('Connect to the internet to check for catalog updates.')
        }}>
          Update Full Catalog
        </button>
      </nav>
      <main className="catalog-main">
        {view === 'catalog' && <div className="catalog-filters" aria-label="Catalog filters" role="group">
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
          <label>Set <input form="catalog-search" placeholder="Name or code" value={filters.set}
            onChange={(event) => setFilters({ ...filters, set: event.target.value })} /></label>
          <label>Format <input form="catalog-search" placeholder="e.g. modern" value={filters.format}
            onChange={(event) => setFilters({ ...filters, format: event.target.value })} /></label>
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
          <button type="submit" form="catalog-search" disabled={busy}>Apply Filters</button>
          <button type="button" disabled={busy} onClick={() => {
            setFilters(defaultFilters)
            requestPrintings({ type: 'search', filters: defaultFilters })
          }}>Clear</button>
        </div>}
        <div className="catalog-status">
          {syncStatus && <p role="status">{syncStatus}</p>}
          {syncError && <p role="alert">Catalog update failed. {syncError}</p>}
          {updatedAt && <p>Catalog updated {new Date(updatedAt).toLocaleString()}</p>}
          {view === 'catalog' && !busy && !updatedAt && !syncStatus && (
            <p>Connect to the internet to download the full card catalog.</p>
          )}
          {error && <p role="alert">{error}</p>}
          <p role="status">
            {busy ? 'Loading…' : view === 'catalog'
              ? (cards.length ? 'Select a card to view its details.' : 'No matching printings.')
              : 'Select a card to move it, then choose a destination pocket.'}
          </p>
        </div>
        {view === 'binder' && selection && <div className="binder-selection">
          <p role="status">{selection.from === undefined ? 'Choose an empty pocket for' : 'Choose a pocket to move or swap'} <strong>{selection.card.name}</strong>{(selection.finish ?? selection.card.ownedFinish) === 'foil' ? ' (foil)' : ''}.</p>
          <button type="button" disabled={busy || Boolean(turn)} onClick={addSpread}>Add Pages</button>
          <button type="button" disabled={busy} onClick={() => setSelection(null)}>Cancel</button>
        </div>}
        <nav className="page-controls" aria-label="Binder pages">
          <button type="button" disabled={busy || Boolean(turn) || !canGoPrevious} onClick={() => turnPage('previous')}>
            <span aria-hidden="true">← </span>Previous
          </button>
          <span aria-live="polite">{cover === 'front' ? 'Front cover' : cover === 'back' ? 'Back cover'
            : `Pages ${page * binderPagesPerSpread + 1}–${(page + 1) * binderPagesPerSpread}`}</span>
          <button type="button" disabled={busy || Boolean(turn) || !canGoNext} onClick={() => turnPage('next')}>
            Next<span aria-hidden="true"> →</span>
          </button>
          {view === 'binder' && !selection && <button type="button" disabled={busy || Boolean(turn)} onClick={addSpread}>Add Spread</button>}
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
                onPocket={(index, card) => choosePocket(page * spreadSize + side * pageSize + index, card)} />
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
          setPreview(null)
          requestPrintings({ type: 'view', view: 'binder' })
        }} />}
    </div>
  )
}

export default App
