import { useEffect, useRef, useState } from 'react'
import { imageFileTypes, importImage } from './importImage'
import { defaultPreferences } from './preferences'
import type { CoverSide, ImportedImage, Preferences } from './preferences'
import { binderSortFields } from './binder'
import type { BinderSortRule } from './binder'

const sortFields = Object.keys(binderSortFields) as BinderSortRule['field'][]

const positions = [
  'Top left', 'Top center', 'Top right',
  'Middle left', 'Center', 'Middle right',
  'Bottom left', 'Bottom center', 'Bottom right',
]

export function BinderCover({ side, preferences }: { side: CoverSide; preferences: Preferences }) {
  const coverImage = preferences.coverImages[side]
  return (
    <div className="binder-cover" data-cover={side} aria-label={side === 'front' ? 'Front cover' : 'Back cover'} role="group">
      {coverImage && <img className="cover-art" src={coverImage.src} alt="" />}
      <div className="cover-binding" aria-hidden="true" />
      {side === 'front' && <h2>{preferences.coverTitle || defaultPreferences.coverTitle}</h2>}
      {preferences.stickers.filter((sticker) => sticker.side === side).map((sticker) => (
        <span className={sticker.image ? 'cover-sticker image-sticker' : 'cover-sticker'} key={sticker.id} style={{
          left: `${20 + (sticker.position % 3) * 30}%`,
          top: `${20 + Math.floor(sticker.position / 3) * 30}%`,
        }}>{sticker.image ? <img src={sticker.image.src} alt={sticker.text} /> : sticker.text}</span>
      ))}
    </div>
  )
}

export function Settings({ preferences, onSave, onClose }: {
  preferences: Preferences
  onSave: (preferences: Preferences) => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState(preferences)
  const [text, setText] = useState('')
  const [stickerImage, setStickerImage] = useState<ImportedImage | null>(null)
  const [processingImage, setProcessingImage] = useState(false)
  const [side, setSide] = useState<CoverSide>('front')
  const [position, setPosition] = useState(0)
  const [error, setError] = useState('')
  const { rules, prioritizedTags } = draft.binderSorting
  const unusedSortFields = sortFields.filter((field) => !rules.some((rule) => rule.field === field))

  useEffect(() => { dialog.current?.showModal() }, [])

  async function loadImage(file: File | undefined, target: CoverSide | 'sticker') {
    if (!file || processingImage) return
    setError('')
    setProcessingImage(true)
    try {
      const image = await importImage(file, target === 'sticker' ? 'sticker' : 'cover')
      if (target === 'sticker') setStickerImage(image)
      else setDraft((current) => ({ ...current, coverImages: { ...current.coverImages, [target]: image } }))
    } catch (error) {
      setError(error instanceof Error ? error.message : 'This image could not be imported.')
    } finally {
      setProcessingImage(false)
    }
  }

  function addSticker() {
    if (!text.trim() && !stickerImage) return
    setDraft({ ...draft, stickers: [
      ...draft.stickers.filter((sticker) => sticker.side !== side || sticker.position !== position),
      { id: `${side}-${position}`, text: text.trim() || stickerImage?.name || '', side, position,
        image: stickerImage ?? undefined },
    ] })
    setText('')
    setStickerImage(null)
  }

  function setSortRules(next: BinderSortRule[]) {
    setDraft({ ...draft, binderSorting: { ...draft.binderSorting, rules: next } })
  }

  function moveSortRule(index: number, offset: number) {
    const next = [...rules]
    const [rule] = next.splice(index, 1)
    next.splice(index + offset, 0, rule)
    setSortRules(next)
  }

  return (
    <dialog className="settings-dialog" ref={dialog} aria-labelledby="settings-title" onClose={onClose}>
      <form onSubmit={(event) => {
        event.preventDefault()
        if (processingImage) return
        try {
          onSave(draft)
        } catch {
          setError('Settings could not be saved on this device.')
        }
      }}>
        <h2 id="settings-title">Settings</h2>
        <fieldset>
          <legend>Appearance</legend>
          <label>Site theme <select value={draft.siteTheme} onChange={(event) =>
            setDraft({ ...draft, siteTheme: event.target.value as Preferences['siteTheme'] })}>
            <option value="dark">Dark</option><option value="light">Light</option><option value="forest">Forest</option>
          </select></label>
          <label>Binder theme <select value={draft.binderTheme} onChange={(event) =>
            setDraft({ ...draft, binderTheme: event.target.value as Preferences['binderTheme'] })}>
            <option value="slate">Slate</option><option value="burgundy">Burgundy</option><option value="evergreen">Evergreen</option>
          </select></label>
          <label>Binding <select value={draft.binding} onChange={(event) =>
            setDraft({ ...draft, binding: event.target.value as Preferences['binding'] })}>
            <option value="stitched">Stitched</option><option value="rings">Rings</option><option value="plain">Plain</option>
          </select></label>
        </fieldset>
        <fieldset>
          <legend>Binder layout</legend>
          <label>Rows per page <select value={draft.rows} onChange={(event) =>
            setDraft({ ...draft, rows: Number(event.target.value) })}>
            {[2, 3, 4].map((size) => <option key={size}>{size}</option>)}
          </select></label>
          <label>Columns per page <select value={draft.columns} onChange={(event) =>
            setDraft({ ...draft, columns: Number(event.target.value) })}>
            {[2, 3, 4].map((size) => <option key={size}>{size}</option>)}
          </select></label>
          <label>Front cover title <input value={draft.coverTitle} maxLength={40} onChange={(event) =>
            setDraft({ ...draft, coverTitle: event.target.value })} /></label>
        </fieldset>
        <fieldset>
          <legend>Binder sorting</legend>
          <ol className="sort-priority-list">
            {rules.map((rule, index) => (
              <li key={rule.field}>
                <label>Field <select value={rule.field} onChange={(event) => {
                  const field = event.target.value as BinderSortRule['field']
                  setSortRules(rules.map((item, position) => position === index ? { ...item, field } : item))
                }}>
                  {sortFields.filter((field) => field === rule.field || unusedSortFields.includes(field)).map((field) =>
                    <option key={field} value={field}>{binderSortFields[field]}</option>)}
                </select></label>
                <label>Order <select value={rule.direction} onChange={(event) => {
                  const direction = event.target.value as BinderSortRule['direction']
                  setSortRules(rules.map((item, position) => position === index ? { ...item, direction } : item))
                }}>
                  <option value="asc">Ascending</option>
                  <option value="desc">Descending</option>
                </select></label>
                <button type="button" title="Raise priority" aria-label={`Raise ${binderSortFields[rule.field]} priority`}
                  disabled={index === 0} onClick={() => moveSortRule(index, -1)}>↑</button>
                <button type="button" title="Lower priority" aria-label={`Lower ${binderSortFields[rule.field]} priority`}
                  disabled={index === rules.length - 1} onClick={() => moveSortRule(index, 1)}>↓</button>
                <button type="button" aria-label={`Remove ${binderSortFields[rule.field]} sort rule`}
                  disabled={rules.length === 1} onClick={() => setSortRules(rules.filter((_, position) => position !== index))}>Remove</button>
              </li>
            ))}
          </ol>
          <button type="button" disabled={!unusedSortFields.length}
            onClick={() => setSortRules([...rules, { field: unusedSortFields[0], direction: 'asc' }])}>Add Sort Rule</button>
          <label className="settings-image">Priority tags, highest first, one per line
            <textarea rows={3} value={prioritizedTags} onChange={(event) =>
              setDraft({ ...draft, binderSorting: { ...draft.binderSorting, prioritizedTags: event.target.value } })} />
          </label>
        </fieldset>
        <fieldset>
          <legend>Cover images</legend>
          {(['front', 'back'] as const).map((coverSide) => {
            const image = draft.coverImages[coverSide]
            return (
              <div className="settings-image" key={coverSide}>
                <label>{coverSide === 'front' ? 'Front cover image' : 'Back cover image'}
                  <input type="file" accept={imageFileTypes} disabled={processingImage} onChange={(event) => {
                    const file = event.currentTarget.files?.[0]
                    event.currentTarget.value = ''
                    void loadImage(file, coverSide)
                  }} />
                </label>
                {image && <div className="image-preview">
                  <img src={image.src} alt={image.name} />
                  <button type="button" disabled={processingImage} onClick={() => setDraft({
                    ...draft, coverImages: { ...draft.coverImages, [coverSide]: undefined },
                  })}>Remove {coverSide} image</button>
                </div>}
              </div>
            )
          })}
          <p className="settings-image">PNG, JPEG, or WebP. Cover art fills the cover and may crop at the edges.</p>
        </fieldset>
        <fieldset>
          <legend>Cover stickers</legend>
          <label>{stickerImage ? 'Image description (optional)' : 'Sticker text or emoji'}
            <input value={text} maxLength={stickerImage ? 80 : 12} onChange={(event) => setText(event.target.value)} />
          </label>
          <label>Sticker image <input type="file" accept={imageFileTypes} disabled={processingImage} onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            void loadImage(file, 'sticker')
          }} /></label>
          {stickerImage && <div className="image-preview settings-image">
            <img src={stickerImage.src} alt={stickerImage.name} />
            <button type="button" disabled={processingImage} onClick={() => setStickerImage(null)}>Clear sticker image</button>
          </div>}
          <label>Cover <select value={side} onChange={(event) => setSide(event.target.value as CoverSide)}>
            <option value="front">Front</option><option value="back">Back</option>
          </select></label>
          <label>Position <select value={position} onChange={(event) => setPosition(Number(event.target.value))}>
            {positions.map((label, index) => <option key={label} value={index}>{label}</option>)}
          </select></label>
          <button type="button" disabled={processingImage || (!text.trim() && !stickerImage)} onClick={addSticker}>Place sticker</button>
          {draft.stickers.length > 0 && <ul className="sticker-list">{draft.stickers.map((sticker) => (
            <li key={sticker.id}>
              <span className="image-preview">
                {sticker.image && <img src={sticker.image.src} alt="" />}
                {sticker.text} · {sticker.side === 'front' ? 'Front' : 'Back'} · {positions[sticker.position]}
              </span>
              <button type="button" onClick={() => setDraft({ ...draft,
                stickers: draft.stickers.filter((item) => item.id !== sticker.id) })}>
                Remove
              </button>
            </li>
          ))}</ul>}
        </fieldset>
        {processingImage && <p role="status">Preparing image…</p>}
        {error && <p role="alert">{error}</p>}
        <div className="settings-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={processingImage}>Save Settings</button>
        </div>
      </form>
    </dialog>
  )
}

