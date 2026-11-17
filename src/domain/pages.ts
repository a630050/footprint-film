import {
  BURST_SECONDS_PER_PHOTO,
  MAX_AUTO_BURST_PHOTOS,
  MAX_COLLAGE_PHOTOS,
  MAX_GRID_PHOTOS
} from '../constants/video-config'
import type {
  DisplayCell,
  JourneySettings,
  PageLayout,
  PageMotion,
  Photo,
  Station,
  StationPage,
  VideoOrientation
} from '../types/journey'

/** 各拼接樣式的中文名稱（介面顯示用） */
export const PAGE_LAYOUT_LABELS: Record<PageLayout, string> = {
  single: '單張',
  columns: '左右並排',
  rows: '上下並排',
  'feature-left': '左大右小',
  'feature-top': '上大下小',
  grid: '宮格',
  polaroid: '拍立得',
  burst: '連拍輪動',
  reveal: '依序出現'
}

export const DEFAULT_PAGE_MOTION: PageMotion = { zoom: 'in', direction: 'none' }

/** 隨機運鏡的候選組合（縮放 × 方向） */
const RANDOM_MOTION_PRESETS: PageMotion[] = [
  { zoom: 'in', direction: 'none' },
  { zoom: 'out', direction: 'none' },
  { zoom: 'in', direction: 'ne' },
  { zoom: 'in', direction: 'sw' },
  { zoom: 'out', direction: 'nw' },
  { zoom: 'out', direction: 'se' },
  { zoom: 'none', direction: 'e' },
  { zoom: 'none', direction: 'w' },
  { zoom: 'in', direction: 'n' },
  { zoom: 'out', direction: 's' }
]

/** FNV-1a 32 位元雜湊：同樣的照片組合永遠得到同樣的亂數，預覽與輸出一致，重畫也不會變 */
export function hashString(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

let pageIdCounter = 0
/** 產生新頁的唯一 ID */
export function createPageId(): string {
  pageIdCounter += 1
  return `pg-${Date.now().toString(36)}-${pageIdCounter}`
}

/** 照片方向是否與影片方向不一致（橫式影片中的直拍照、直式影片中的橫拍照） */
export function isOrientationMismatch(photo: Photo, orientation: VideoOrientation): boolean {
  return orientation === 'landscape' ? photo.height > photo.width : photo.width >= photo.height
}

/** 兩張照片是否屬於同一組連拍（拍攝時間相隔不超過門檻） */
function isBurstNeighbor(a: Photo, b: Photo, thresholdSec: number): boolean {
  if (thresholdSec <= 0 || a.captureTimeUtc === undefined || b.captureTimeUtc === undefined) return false
  return Math.abs(b.captureTimeUtc - a.captureTimeUtc) <= thresholdSec * 1000
}

/** 一頁照片是否為連拍（相鄰照片都在門檻內） */
export function isBurstPhotos(photos: Photo[], thresholdSec: number): boolean {
  if (photos.length < 2) return false
  for (let i = 1; i < photos.length; i++) {
    if (!isBurstNeighbor(photos[i - 1], photos[i], thresholdSec)) return false
  }
  return true
}

/**
 * 依規則自動分頁：
 * 1. 拍攝時間相隔不超過連拍門檻的連續照片合成一頁（超過 12 張切成多頁）
 * 2. 其餘單張照片依「自動拼圖」規則：連續的直拍（橫式影片）或橫拍（直式影片）照片，3 張或 2 張合成一頁
 */
export function buildAutoPages(stationPhotos: Photo[], settings: JourneySettings): StationPage[] {
  const groups: Photo[][] = []
  for (const photo of stationPhotos) {
    const current = groups[groups.length - 1]
    if (current && isBurstNeighbor(current[current.length - 1], photo, settings.burstThresholdSec)) {
      current.push(photo)
    } else {
      groups.push([photo])
    }
  }

  const pages: Photo[][] = []
  let pendingSingles: Photo[] = []
  const flushSingles = () => {
    if (pendingSingles.length === 0) return
    pages.push(...groupSinglesForCollage(pendingSingles, settings))
    pendingSingles = []
  }

  for (const group of groups) {
    if (group.length === 1) {
      pendingSingles.push(group[0])
      continue
    }
    flushSingles()
    for (let i = 0; i < group.length; i += MAX_AUTO_BURST_PHOTOS) {
      pages.push(group.slice(i, i + MAX_AUTO_BURST_PHOTOS))
    }
  }
  flushSingles()

  return pages.map((photos) => ({ id: `auto-${photos[0].id}`, photoIds: photos.map((p) => p.id) }))
}

/** 自動拼圖：連續的方向不合照片，橫式影片 3 張一組（剩 2 張就 2 張），直式影片 2 張一組 */
function groupSinglesForCollage(photos: Photo[], settings: JourneySettings): Photo[][] {
  if (!settings.autoCollage) return photos.map((p) => [p])
  const maxPerCollage = settings.orientation === 'landscape' ? 3 : 2
  const result: Photo[][] = []
  let run: Photo[] = []
  const flushRun = () => {
    let r = 0
    while (r < run.length) {
      const remaining = run.length - r
      const take = remaining >= maxPerCollage ? maxPerCollage : remaining >= 2 && maxPerCollage === 3 ? 2 : 1
      result.push(run.slice(r, r + take))
      r += take
    }
    run = []
  }
  for (const photo of photos) {
    if (isOrientationMismatch(photo, settings.orientation)) {
      run.push(photo)
    } else {
      flushRun()
      result.push([photo])
    }
  }
  flushRun()
  return result
}

/**
 * 取得站點目前的分頁：
 * - 使用者手動分頁過（station.pages 有值）：以它為準，移除已不在站點內的照片、刪掉空頁，
 *   站點內還沒排進任何頁的照片（例如剛從別站移過來）各自成為新的一頁接在最後
 * - 否則依自動規則產生
 */
export function resolveStationPages(
  station: Station,
  photosMap: Record<string, Photo>,
  settings: JourneySettings
): StationPage[] {
  const memberIds = new Set(station.photoIds.filter((id) => photosMap[id]))
  if (!station.pages) {
    const photos = station.photoIds.map((id) => photosMap[id]).filter((p): p is Photo => Boolean(p))
    return buildAutoPages(photos, settings)
  }

  const seen = new Set<string>()
  const pages: StationPage[] = []
  for (const page of station.pages) {
    const ids = page.photoIds.filter((id) => memberIds.has(id) && !seen.has(id))
    ids.forEach((id) => seen.add(id))
    if (ids.length > 0) pages.push({ ...page, photoIds: ids })
  }
  for (const id of station.photoIds) {
    if (memberIds.has(id) && !seen.has(id)) {
      seen.add(id)
      pages.push({ id: `extra-${id}`, photoIds: [id] })
    }
  }
  return pages
}

/** 依張數列出可用的拼接樣式 */
export function getAvailableLayouts(count: number): PageLayout[] {
  if (count <= 1) return ['single']
  if (count <= MAX_COLLAGE_PHOTOS) {
    const layouts: PageLayout[] = ['columns', 'rows', 'feature-left', 'feature-top']
    if (count === 4) layouts.push('grid')
    return [...layouts, 'polaroid', 'reveal', 'burst']
  }
  if (count <= MAX_GRID_PHOTOS) return ['grid', 'polaroid', 'reveal', 'burst']
  return ['burst']
}

/** 不隨機時的預設樣式 */
function defaultLayout(photos: Photo[], settings: JourneySettings, isBurst: boolean): PageLayout {
  const count = photos.length
  if (count <= 1) return 'single'
  const mismatchCount = photos.filter((p) => isOrientationMismatch(p, settings.orientation)).length
  const mostlyMismatch = mismatchCount * 2 >= count
  if (isBurst && (count >= 3 || !mostlyMismatch)) return 'burst'
  if (count > MAX_GRID_PHOTOS) return 'burst'
  if (count > MAX_COLLAGE_PHOTOS) return 'grid'
  if (count === 4 && !mostlyMismatch) return 'grid'
  if (mostlyMismatch) return settings.orientation === 'landscape' ? 'columns' : 'rows'
  return settings.orientation === 'landscape' ? 'feature-left' : 'feature-top'
}

/** 隨機時，依照片方向挑出看起來合適的候選樣式 */
function randomLayoutCandidates(photos: Photo[], settings: JourneySettings, isBurst: boolean): PageLayout[] {
  const count = photos.length
  const available = getAvailableLayouts(count)
  if (available.length === 1) return available
  const mismatchCount = photos.filter((p) => isOrientationMismatch(p, settings.orientation)).length
  const mostlyMismatch = mismatchCount * 2 >= count
  const landscapeVideo = settings.orientation === 'landscape'

  let preferred: PageLayout[]
  if (isBurst) {
    preferred = ['burst', 'reveal', 'polaroid', 'grid']
  } else if (mostlyMismatch) {
    // 橫式影片中的直拍照適合左右排；直式影片中的橫拍照適合上下排
    preferred = landscapeVideo
      ? ['columns', 'feature-left', 'polaroid', 'reveal']
      : ['rows', 'feature-top', 'polaroid', 'reveal']
  } else {
    preferred = landscapeVideo
      ? ['feature-left', 'grid', 'polaroid', 'reveal']
      : ['feature-top', 'grid', 'polaroid', 'reveal']
  }
  const candidates = preferred.filter((l) => available.includes(l))
  return candidates.length > 0 ? candidates : available
}

/** 每頁的播放長度 */
export function computePageDurationMs(layout: PageLayout, count: number, secondsPerCell: number): number {
  const base = secondsPerCell * 1000
  if (layout === 'burst') {
    return Math.round(Math.min(base * 2, Math.max(base, count * BURST_SECONDS_PER_PHOTO * 1000)))
  }
  if (layout === 'reveal' || layout === 'polaroid') {
    return Math.round(Math.min(base * 2, base + (count - 1) * 250))
  }
  return Math.round(base)
}

/**
 * 決定一頁實際的樣式與運鏡：手動設定優先；未設定時依「隨機」開關決定隨機或預設。
 * 手動選的樣式若因取消入選導致張數不合，改用自動結果
 */
export function resolvePageStyle(
  page: StationPage,
  includedPhotos: Photo[],
  settings: JourneySettings,
  previousMotion?: PageMotion
): { layout: PageLayout; motion: PageMotion; seed: number } {
  const seed = hashString(includedPhotos.map((p) => p.id).join('|'))
  const count = includedPhotos.length
  const available = getAvailableLayouts(count)
  const isBurst = isBurstPhotos(includedPhotos, settings.burstThresholdSec)

  let layout: PageLayout
  if (page.layout && available.includes(page.layout)) {
    layout = page.layout
  } else if (settings.randomLayout && count > 1) {
    const candidates = randomLayoutCandidates(includedPhotos, settings, isBurst)
    layout = candidates[seed % candidates.length]
  } else {
    layout = defaultLayout(includedPhotos, settings, isBurst)
  }

  let motion: PageMotion
  if (page.motion) {
    motion = page.motion
  } else if (settings.randomMotion) {
    let idx = hashString(`${seed}:motion`) % RANDOM_MOTION_PRESETS.length
    const candidate = RANDOM_MOTION_PRESETS[idx]
    // 避免連續兩頁同一種運鏡
    if (previousMotion && candidate.zoom === previousMotion.zoom && candidate.direction === previousMotion.direction) {
      idx = (idx + 1) % RANDOM_MOTION_PRESETS.length
    }
    motion = RANDOM_MOTION_PRESETS[idx]
  } else {
    motion = DEFAULT_PAGE_MOTION
  }

  return { layout, motion, seed }
}

/** 把站點的每一頁轉成可直接渲染的展示格（只留入選照片，沒有入選照片的頁略過） */
export function buildStationCells(
  station: Station,
  photosMap: Record<string, Photo>,
  settings: JourneySettings
): DisplayCell[] {
  const cells: DisplayCell[] = []
  let previousMotion: PageMotion | undefined
  for (const page of resolveStationPages(station, photosMap, settings)) {
    const included = page.photoIds.map((id) => photosMap[id]).filter((p): p is Photo => Boolean(p && p.included))
    if (included.length === 0) continue
    const { layout, motion, seed } = resolvePageStyle(page, included, settings, previousMotion)
    previousMotion = motion
    cells.push({
      photoIds: included.map((p) => p.id),
      durationMs: computePageDurationMs(layout, included.length, settings.secondsPerCell),
      layout,
      motion,
      seed
    })
  }
  return cells
}

/* ───────────── 編輯操作（純函式，回傳新的頁陣列） ───────────── */

/**
 * 點擊兩張照片之間的空隙：
 * - 兩張在同一頁 → 從這裡切開成兩頁（前半保留原本的樣式設定）
 * - 兩張分屬相鄰兩頁（中間已有分隔線）→ 合併成一頁（沿用前一頁的樣式設定）
 */
export function togglePageBreak(pages: StationPage[], beforePhotoId: string, afterPhotoId: string): StationPage[] {
  const beforeIdx = pages.findIndex((p) => p.photoIds.includes(beforePhotoId))
  const afterIdx = pages.findIndex((p) => p.photoIds.includes(afterPhotoId))
  if (beforeIdx < 0 || afterIdx < 0) return pages

  if (beforeIdx === afterIdx) {
    const page = pages[beforeIdx]
    const cut = page.photoIds.indexOf(beforePhotoId) + 1
    const first: StationPage = { ...page, photoIds: page.photoIds.slice(0, cut) }
    const second: StationPage = { id: createPageId(), photoIds: page.photoIds.slice(cut) }
    return [...pages.slice(0, beforeIdx), first, second, ...pages.slice(beforeIdx + 1)]
  }

  if (afterIdx === beforeIdx + 1) {
    const merged: StationPage = {
      ...pages[beforeIdx],
      photoIds: [...pages[beforeIdx].photoIds, ...pages[afterIdx].photoIds]
    }
    return [...pages.slice(0, beforeIdx), merged, ...pages.slice(afterIdx + 1)]
  }
  return pages
}

/** 兩張照片之間目前是否有分隔線（分屬不同頁） */
export function hasBreakBetween(pages: StationPage[], beforePhotoId: string, afterPhotoId: string): boolean {
  const a = pages.findIndex((p) => p.photoIds.includes(beforePhotoId))
  const b = pages.findIndex((p) => p.photoIds.includes(afterPhotoId))
  return a !== b
}

/**
 * 拖曳排序：把照片移到另一張照片的位置（落在目標照片所在的頁，排在它前面或後面）
 * @param placeAfter true = 放在目標照片之後
 */
export function movePhotoInPages(
  pages: StationPage[],
  photoId: string,
  targetPhotoId: string,
  placeAfter: boolean
): StationPage[] {
  if (photoId === targetPhotoId) return pages
  const removed = pages
    .map((p) => ({ ...p, photoIds: p.photoIds.filter((id) => id !== photoId) }))
  const targetPageIdx = removed.findIndex((p) => p.photoIds.includes(targetPhotoId))
  if (targetPageIdx < 0) return pages
  const targetPage = removed[targetPageIdx]
  const insertAt = targetPage.photoIds.indexOf(targetPhotoId) + (placeAfter ? 1 : 0)
  const ids = [...targetPage.photoIds]
  ids.splice(insertAt, 0, photoId)
  removed[targetPageIdx] = { ...targetPage, photoIds: ids }
  return removed.filter((p) => p.photoIds.length > 0)
}

/** 設定某一頁的樣式或運鏡（傳 undefined 代表改回自動） */
export function updatePageStyle(
  pages: StationPage[],
  pageId: string,
  patch: { layout?: PageLayout | undefined; motion?: PageMotion | undefined }
): StationPage[] {
  return pages.map((p) => (p.id === pageId ? { ...p, ...patch } : p))
}
