import exifr from 'exifr'
import { MAX_PHOTO_DIMENSION_PX } from '../constants/video-config'
import { parseCaptureTime } from '../domain/capture-time'
import type { Coordinates, Photo } from '../types/journey'

/** 支援的圖片副檔名 */
const SUPPORTED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']

/** 影片副檔名（用於偵測並提示略過） */
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.3gp']

/**
 * 檢查檔案是否為影片檔
 * @param file 檔案物件
 */
export function isVideoFile(file: File): boolean {
  if (file.type.startsWith('video/')) return true
  const lower = file.name.toLowerCase()
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/**
 * 檢查檔案是否為支援的照片格式
 * @param file 檔案物件
 */
export function isSupportedPhotoFile(file: File): boolean {
  const lower = file.name.toLowerCase()
  if (SUPPORTED_IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return true
  }
  return (
    file.type === 'image/jpeg' ||
    file.type === 'image/png' ||
    file.type === 'image/webp' ||
    file.type === 'image/heic' ||
    file.type === 'image/heif'
  )
}

/**
 * 檢查檔案是否為 HEIC/HEIF 格式
 */
function isHeicFile(file: File): boolean {
  const lower = file.name.toLowerCase()
  return (
    lower.endsWith('.heic') ||
    lower.endsWith('.heif') ||
    file.type === 'image/heic' ||
    file.type === 'image/heif'
  )
}

/**
 * 讀取照片開頭的 EXIF 資訊（只讀前 128KB 以降低記憶體開銷）
 * @param file 原始照片檔案
 */
async function extractPhotoExif(file: File): Promise<{
  captureTimeUtc?: number
  localDate?: string
  coordinates?: Coordinates
  orientation?: number
}> {
  try {
    const rawExif = await exifr.parse(file, {
      tiff: true,
      exif: true,
      gps: true,
      firstChunkSize: 65536,
      chunkSize: 65536,
      chunkLimit: 2
    })

    if (!rawExif) return {}

    // 為了取得原始字串格式的 DateTimeOriginal，避免被自動轉成執行環境時區的 Date
    const { captureTimeUtc, localDate } = parseCaptureTime({
      dateTimeOriginal: rawExif.DateTimeOriginal ?? rawExif.CreateDate,
      offsetTimeOriginal: rawExif.OffsetTimeOriginal ?? rawExif.OffsetTime,
      gpsDateStamp: rawExif.GPSDateStamp,
      gpsTimeStamp: rawExif.GPSTimeStamp
    })

    let coordinates: Coordinates | undefined
    if (
      typeof rawExif.latitude === 'number' &&
      typeof rawExif.longitude === 'number' &&
      !isNaN(rawExif.latitude) &&
      !isNaN(rawExif.longitude)
    ) {
      coordinates = {
        latitude: rawExif.latitude,
        longitude: rawExif.longitude
      }
    }

    const orientation =
      typeof rawExif.Orientation === 'number' ? rawExif.Orientation : undefined

    return {
      captureTimeUtc,
      localDate,
      coordinates,
      orientation
    }
  } catch {
    return {}
  }
}

/**
 * 將圖片 Blob 解碼並縮小至長邊最大 1920px，同時處理旋轉方向，最後輸出為 JPEG Blob
 * @param blob 原始或轉檔後的圖片 Blob
 * @returns 縮小後的 Blob 與寬高
 */
async function downscaleImageBlob(
  blob: Blob
): Promise<{ imageBlob: Blob; width: number; height: number }> {
  // createImageBitmap 在現代瀏覽器預設會依據 EXIF Orientation 自動轉正 (imageOrientation: 'from-image')
  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(blob, {
      imageOrientation: 'from-image'
    })
    const srcW = bitmap.width
    const srcH = bitmap.height
    const maxSide = Math.max(srcW, srcH)
    const scale = maxSide > MAX_PHOTO_DIMENSION_PX ? MAX_PHOTO_DIMENSION_PX / maxSide : 1
    const targetW = Math.max(1, Math.round(srcW * scale))
    const targetH = Math.max(1, Math.round(srcH * scale))

    const canvas = document.createElement('canvas')
    canvas.width = targetW
    canvas.height = targetH
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('無法建立 2D 畫布進行影像縮小')
    }
    ctx.drawImage(bitmap, 0, 0, targetW, targetH)
    bitmap.close()
    bitmap = null

    const resizedBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => {
          if (b) resolve(b)
          else reject(new Error('影像轉換 Blob 失敗'))
        },
        'image/jpeg',
        0.88
      )
    })

    // 釋放畫布記憶體
    canvas.width = 0
    canvas.height = 0

    return {
      imageBlob: resizedBlob,
      width: targetW,
      height: targetH
    }
  } finally {
    if (bitmap) {
      bitmap.close()
    }
  }
}

/**
 * 處理 HEIC 檔案：先嘗試瀏覽器原生解碼（如 iOS/macOS Safari），失敗時才動態載入 `heic2any`
 * @param file HEIC 檔案
 */
export async function decodeAndDownscaleWithHeicFallback(
  file: File
): Promise<{ imageBlob: Blob; width: number; height: number }> {
  try {
    // 1. 優先嘗試原生解碼
    return await downscaleImageBlob(file)
  } catch {
    if (!isHeicFile(file)) {
      throw new Error(`無法解碼圖片檔案：${file.name}`)
    }
    // 2. 動態載入 heic2any
    const heic2anyModule = await import('heic2any')
    const heic2any = heic2anyModule.default ?? heic2anyModule
    const converted = await heic2any({
      blob: file,
      toType: 'image/jpeg',
      quality: 0.9
    })
    const singleBlob = Array.isArray(converted) ? converted[0] : converted
    return await downscaleImageBlob(singleBlob)
  }
}

/**
 * 讀取並縮小單張照片，完成後立即釋放原始資源
 * @param file 使用者選取的檔案
 * @param id 照片唯一識別碼
 */
export async function processSinglePhotoFile(file: File, id: string): Promise<Photo> {
  // 1. 先從原檔開頭提取 EXIF（包含 HEIC 內的 EXIF）
  const exif = await extractPhotoExif(file)

  // 2. 解碼並縮小至長邊 ≤ 1920px
  const { imageBlob, width, height } = await decodeAndDownscaleWithHeicFallback(file)

  return {
    id,
    fileName: file.name,
    imageBlob,
    width,
    height,
    captureTimeUtc: exif.captureTimeUtc,
    localDate: exif.localDate,
    coordinates: exif.coordinates,
    locationSource: exif.coordinates ? 'exif' : 'none',
    included: true
  }
}

export interface BatchPhotoReadProgress {
  completedCount: number
  totalCount: number
  currentFileName: string
}

export interface BatchPhotoReadResult {
  photos: Photo[]
  skippedVideos: string[]
  failedFiles: string[]
  skippedDuplicates: string[]
}

/**
 * 判斷兩張照片是否可視為重複選取（檔名相同且拍攝時間相同；無時間時改比對縮圖尺寸）
 */
export function isDuplicatePhoto(candidate: Pick<Photo, 'fileName' | 'captureTimeUtc' | 'width' | 'height'>, existing: Pick<Photo, 'fileName' | 'captureTimeUtc' | 'width' | 'height'>): boolean {
  if (candidate.fileName !== existing.fileName) return false
  if (candidate.captureTimeUtc !== undefined && existing.captureTimeUtc !== undefined) {
    return candidate.captureTimeUtc === existing.captureTimeUtc
  }
  if (candidate.captureTimeUtc === undefined && existing.captureTimeUtc === undefined) {
    return candidate.width === existing.width && candidate.height === existing.height
  }
  return false
}

/**
 * 依序處理多張照片（避免同時解碼多張大圖造成行動裝置記憶體崩潰）
 * @param files 檔案清單
 * @param onProgress 進度回呼
 * @param existingPhotos 目前旅程中已載入的照片清單（用於略過重複選取的照片）
 */
export async function processPhotoFilesSequentially(
  files: File[],
  onProgress?: (progress: BatchPhotoReadProgress) => void,
  existingPhotos: Photo[] = []
): Promise<BatchPhotoReadResult> {
  const skippedVideos: string[] = []
  const failedFiles: string[] = []
  const skippedDuplicates: string[] = []
  const candidateFiles: File[] = []

  for (const f of files) {
    if (isVideoFile(f)) {
      skippedVideos.push(f.name)
    } else if (isSupportedPhotoFile(f)) {
      candidateFiles.push(f)
    } else {
      failedFiles.push(f.name)
    }
  }

  const photos: Photo[] = []
  const knownPhotos: Photo[] = [...existingPhotos]
  const totalCount = candidateFiles.length

  for (let i = 0; i < candidateFiles.length; i++) {
    const file = candidateFiles[i]
    onProgress?.({
      completedCount: i,
      totalCount,
      currentFileName: file.name
    })

    try {
      const id = `photo-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`
      const photo = await processSinglePhotoFile(file, id)
      if (knownPhotos.some((known) => isDuplicatePhoto(photo, known))) {
        skippedDuplicates.push(file.name)
        continue
      }
      photos.push(photo)
      knownPhotos.push(photo)
    } catch {
      failedFiles.push(file.name)
    }
  }

  onProgress?.({
    completedCount: totalCount,
    totalCount,
    currentFileName: ''
  })

  return {
    photos,
    skippedVideos,
    failedFiles,
    skippedDuplicates
  }
}
