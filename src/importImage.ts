import type { ImportedImage } from './preferences'

const supportedTypes = ['image/jpeg', 'image/png', 'image/webp']
const maxFileSize = 20 * 1024 * 1024

export const imageFileTypes = supportedTypes.join(',')

export async function importImage(file: File, purpose: 'cover' | 'sticker'): Promise<ImportedImage> {
  if (!supportedTypes.includes(file.type)) throw new Error('Choose a PNG, JPEG, or WebP image.')
  if (file.size > maxFileSize) throw new Error('Choose an image smaller than 20 MB.')

  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('This image could not be opened. Try another file.')
  })

  try {
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Image processing is unavailable in this browser.')

    const maxLength = purpose === 'cover' ? 200_000 : 65_000
    const maxDimension = purpose === 'cover' ? 1440 : 400
    let scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height))

    for (let attempt = 0; attempt < 6; attempt += 1) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const src = canvas.toDataURL('image/webp', 0.84)
      if (src !== 'data:,' && src.length <= maxLength) return { src, name: file.name }
      scale *= 0.72
    }
    throw new Error('This image could not be sized to fit local storage.')
  } finally {
    bitmap.close()
  }
}
