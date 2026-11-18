import { COLLAGE_GAP_PX, TRANSITION_FADE_MS } from '../constants/video-config'
import { cameraAt, evaluateMoveSegmentAt } from '../domain/camera-path'
import { formatJourneyDateRange, formatLocalDateDisplay } from '../domain/capture-time'
import { resolveDisplayCellOverlayText } from '../domain/display-cells'
import {
  computeMotionTransform,
  computePolaroidPlacements,
  computeTileRects,
  type Rect
} from '../domain/page-geometry'
import { cropExceedsImage, fitCropToAspect } from '../domain/photo-crop'
import { locateTimelinePosition } from '../domain/timeline-builder'
import { DEFAULT_VISUAL_THEME } from '../themes/default-theme'
import type { DisplayCell, Journey, Photo, Segment, Station } from '../types/journey'
import { DeterministicMapRenderer, sliceRouteByProgress } from './map-renderer'
import { drawTravelerMarker, travelerMarkerRadius } from './traveler-marker'

/** 地圖資料版權標示（OpenFreeMap / OpenMapTiles / OpenStreetMap 授權要求） */
export const MAP_ATTRIBUTION_TEXT = 'OpenFreeMap © OpenMapTiles  Data © OpenStreetMap contributors'

/** 同時保留在記憶體中的已解碼照片數量上限（單張 1920px 約 11MB，14 張約 155MB；宮格一頁最多 9 張） */
const MAX_DECODED_BITMAPS = 14

/** 預先模糊背景的長邊像素（放大後即產生柔和模糊效果，所有瀏覽器皆一致） */
const BLURRED_BACKGROUND_LONG_SIDE = 48

/**
 * 畫面文字與標記的比例：以 1080p 為 1，720p 約 0.67。
 * 文字大小以「手機全螢幕觀看時一般視力可輕鬆閱讀」為準：地名約 40px（1080p）
 */
function uiScaleFor(width: number, height: number): number {
  return Math.max(0.65, Math.min(width, height) / 1080)
}

/**
 * 取得站點的顯示名稱（customName 優先於 autoName）
 */
export function getStationDisplayName(station?: Station): string {
  if (!station) return ''
  if (station.customName && station.customName.trim().length > 0) {
    return station.customName.trim()
  }
  return station.autoName
}

/**
 * 取得旅程中所有至少有一張入選照片的有效站點
 */
export function getActiveStations(journey: Journey): Station[] {
  return journey.stations.filter((st) =>
    st.photoIds.some((id) => journey.photos[id]?.included)
  )
}

/**
 * 取得旅程封面照片（若無指定或已刪除，預設為第一站第一張入選照片）
 */
export function resolveCoverPhoto(journey: Journey): Photo | undefined {
  if (journey.coverPhotoId && journey.photos[journey.coverPhotoId]) {
    return journey.photos[journey.coverPhotoId]
  }
  for (const st of journey.stations) {
    for (const id of st.photoIds) {
      const p = journey.photos[id]
      if (p && p.included) return p
    }
  }
  return Object.values(journey.photos)[0]
}

/** 建立離屏暫存畫布 */
function createScratchCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

/**
 * 依可用寬度截斷文字，超出時加上「…」
 */
function fitTextToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  const chars = Array.from(text)
  let lo = 0
  let hi = chars.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (ctx.measureText(chars.slice(0, mid).join('') + '…').width <= maxWidth) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }
  return chars.slice(0, lo).join('') + '…'
}

/**
 * 圓角矩形繪製輔助函式
 */
function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

type DrawableImage = ImageBitmap | HTMLCanvasElement

/**
 * 以 Object-Fit: Cover（填滿並置中裁切）方式繪製圖片，支援縮放倍率
 */
function drawImageCover(
  ctx: CanvasRenderingContext2D,
  image: DrawableImage,
  destX: number,
  destY: number,
  destW: number,
  destH: number,
  zoomScale = 1
): void {
  ctx.save()
  ctx.beginPath()
  ctx.rect(destX, destY, destW, destH)
  ctx.clip()

  const imgRatio = image.width / image.height
  const boxRatio = destW / destH

  let drawW: number
  let drawH: number
  if (imgRatio > boxRatio) {
    drawH = destH
    drawW = destH * imgRatio
  } else {
    drawW = destW
    drawH = destW / imgRatio
  }

  drawW *= zoomScale
  drawH *= zoomScale

  ctx.drawImage(image, destX + (destW - drawW) / 2, destY + (destH - drawH) / 2, drawW, drawH)
  ctx.restore()
}

/**
 * 在畫布上繪製站點標記（黃色圓點＋白框＋呼吸效果）
 */
function drawStationMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale = 1,
  isHighlighted = false,
  pulsePhase = 0
): void {
  if (scale <= 0.01) return
  const theme = DEFAULT_VISUAL_THEME.stationMarker
  const ui = uiScaleFor(ctx.canvas.width, ctx.canvas.height)
  const baseRadius = theme.radiusPx * scale * ui

  ctx.save()
  if (isHighlighted) {
    const pulseRadius = baseRadius * (1.5 + 0.35 * Math.sin(pulsePhase * Math.PI * 2))
    ctx.beginPath()
    ctx.arc(x, y, pulseRadius, 0, Math.PI * 2)
    ctx.fillStyle = theme.pulseColor
    ctx.fill()
  }

  ctx.beginPath()
  ctx.arc(x, y, baseRadius, 0, Math.PI * 2)
  ctx.fillStyle = isHighlighted ? theme.ActiveFillColor : theme.fillColor
  ctx.fill()
  ctx.lineWidth = theme.strokeWidth * scale * ui
  ctx.strokeStyle = theme.strokeColor
  ctx.stroke()
  ctx.restore()
}

/**
 * 在畫布上繪製地名氣泡（白底黑字圓角卡片，位於標記上方）
 */
function drawPlaceBubble(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  scale: number,
  canvasWidth: number,
  canvasHeight: number,
  anchorOffsetPx = 0
): void {
  if (!text || scale <= 0.05) return
  const theme = DEFAULT_VISUAL_THEME.placeBubble
  const fontScale = uiScaleFor(canvasWidth, canvasHeight)
  const fontSize = Math.round(40 * fontScale * scale)

  ctx.save()
  ctx.font = `700 ${fontSize}px ${DEFAULT_VISUAL_THEME.fontFamily}`
  const padX = fontSize * 0.6
  const padY = fontSize * 0.36
  const label = fitTextToWidth(ctx, text, canvasWidth * 0.8)
  const boxW = ctx.measureText(label).width + padX * 2
  const boxH = fontSize + padY * 2

  const margin = 16 * fontScale
  // 氣泡底部與標記之間的距離：至少 30px，若標記較大（大頭照）則再往上讓
  const gap = Math.max(30 * fontScale, anchorOffsetPx + 12 * fontScale)
  const boxX = Math.max(margin, Math.min(canvasWidth - boxW - margin, x - boxW / 2))
  // 上方空間不夠時改放到標記下方，避免氣泡壓住移動標記
  const aboveY = y - gap - boxH
  const boxY = aboveY >= margin ? aboveY : Math.min(canvasHeight - boxH - margin, y + gap)

  ctx.shadowColor = theme.shadowColor
  ctx.shadowBlur = 16
  ctx.shadowOffsetY = 4

  drawRoundedRect(ctx, boxX, boxY, boxW, boxH, Math.max(theme.borderRadiusPx * fontScale, fontSize * 0.45))
  ctx.fillStyle = theme.backgroundColor
  ctx.fill()

  ctx.shadowColor = 'transparent'
  ctx.fillStyle = theme.textColor
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.fillText(label, boxX + boxW / 2, boxY + boxH / 2 + 1)
  ctx.restore()
}

/**
 * 以 Canvas 2D 繪製路線（外光暈＋主線），線寬依畫布尺寸等比例縮放
 */
function drawRouteLines(
  ctx: CanvasRenderingContext2D,
  mapRenderer: DeterministicMapRenderer,
  routes: [number, number][][],
  width: number,
  height: number
): void {
  const theme = DEFAULT_VISUAL_THEME.routeLine
  const scale = Math.max(0.65, Math.min(width, height) / 1080)
  const projected = routes.filter((r) => r.length >= 2).map((r) => mapRenderer.projectRoute(r))
  if (projected.length === 0) return

  const strokeAll = (color: string, lineWidth: number) => {
    ctx.strokeStyle = color
    ctx.lineWidth = lineWidth
    for (const pts of projected) {
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
      ctx.stroke()
    }
  }

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  strokeAll(theme.glowColor, (theme.widthPx + 8) * scale)
  strokeAll(theme.color, theme.widthPx * scale)
  ctx.restore()
}

/**
 * 繪製底部暗色線性漸層遮罩
 */
function drawBottomGradientMask(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): void {
  const maskH = height * DEFAULT_VISUAL_THEME.overlayGradient.heightRatio
  const grad = ctx.createLinearGradient(0, height - maskH, 0, height)
  grad.addColorStop(0, 'rgba(0, 0, 0, 0)')
  grad.addColorStop(1, `rgba(0, 0, 0, ${DEFAULT_VISUAL_THEME.overlayGradient.bottomStopAlpha})`)
  ctx.save()
  ctx.fillStyle = grad
  ctx.fillRect(0, height - maskH, width, maskH)
  ctx.restore()
}

/**
 * 繪製地圖資料版權標示（右下角小字）
 */
function drawMapAttribution(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  alpha = 1
): void {
  const scale = uiScaleFor(width, height)
  const fontSize = Math.round(18 * scale)
  ctx.save()
  ctx.globalAlpha = alpha * 0.85
  ctx.font = `500 ${fontSize}px ${DEFAULT_VISUAL_THEME.fontFamily}`
  ctx.textAlign = 'right'
  ctx.textBaseline = 'bottom'
  const pad = Math.round(10 * scale)
  const textW = ctx.measureText(MAP_ATTRIBUTION_TEXT).width
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)'
  ctx.fillRect(width - textW - pad * 2, height - fontSize - pad * 1.4, textW + pad * 2, fontSize + pad * 1.4)
  ctx.fillStyle = '#334155'
  ctx.fillText(MAP_ATTRIBUTION_TEXT, width - pad, height - pad * 0.6)
  ctx.restore()
}

/**
 * 主畫布圖層合成器：負責將「場景層（地圖或照片／拼圖）＋遮罩層＋文字層」繪製到主 Canvas
 * - 已解碼照片以 LRU 方式保留最多 MAX_DECODED_BITMAPS 張，避免 100 張照片同時解碼導致手機記憶體崩潰
 * - 模糊背景改為「縮小後再放大」預先產生並快取，不依賴 ctx.filter（舊版 Safari 不支援且逐幀模糊非常耗效能）
 * - 段落之間以真正的交叉淡化銜接：快取前一段落最後一幀，在新段落前 0.5 秒疊加淡出
 */
export class FramePainter {
  private bitmapCache = new Map<string, ImageBitmap>()
  private pendingDecodes = new Map<string, Promise<ImageBitmap | null>>()
  private blurredCache = new Map<string, HTMLCanvasElement>()
  private outgoingSnapshot: { timeline: Segment[]; index: number; width: number; height: number; canvas: HTMLCanvasElement } | null = null
  private mapBlurCanvas: HTMLCanvasElement | null = null
  private avatarCache: { blob: Blob; bitmap: ImageBitmap | null; pending: Promise<ImageBitmap | null> } | null = null

  /**
   * 取得移動標記用的大頭照（同一個 Blob 只解碼一次）
   */
  private async getAvatarBitmap(blob: Blob | undefined): Promise<ImageBitmap | null> {
    if (!blob) return null
    if (this.avatarCache?.blob === blob) {
      return this.avatarCache.bitmap ?? this.avatarCache.pending
    }
    this.avatarCache?.bitmap?.close()
    const entry: { blob: Blob; bitmap: ImageBitmap | null; pending: Promise<ImageBitmap | null> } = {
      blob,
      bitmap: null,
      pending: Promise.resolve(null)
    }
    entry.pending = createImageBitmap(blob)
      .then((bmp) => {
        entry.bitmap = bmp
        return bmp
      })
      .catch(() => null)
    this.avatarCache = entry
    return entry.pending
  }

  /**
   * 取得單張照片的 ImageBitmap（LRU 快取）
   */
  async getPhotoBitmap(photo: Photo): Promise<ImageBitmap | null> {
    const cached = this.bitmapCache.get(photo.id)
    if (cached) {
      // 重新插入以更新 LRU 順序
      this.bitmapCache.delete(photo.id)
      this.bitmapCache.set(photo.id, cached)
      return cached
    }

    const pending = this.pendingDecodes.get(photo.id)
    if (pending) return pending

    const decode = (async () => {
      try {
        const bmp = await createImageBitmap(photo.imageBlob)
        this.bitmapCache.set(photo.id, bmp)
        this.evictBitmaps()
        return bmp
      } catch {
        return null
      } finally {
        this.pendingDecodes.delete(photo.id)
      }
    })()
    this.pendingDecodes.set(photo.id, decode)
    return decode
  }

  private evictBitmaps(): void {
    while (this.bitmapCache.size > MAX_DECODED_BITMAPS) {
      const oldestKey = this.bitmapCache.keys().next().value as string
      this.bitmapCache.get(oldestKey)?.close()
      this.bitmapCache.delete(oldestKey)
    }
  }

  /**
   * 取得照片的預先模糊背景（極小尺寸，放大繪製時即呈現模糊效果）
   */
  private getBlurredBackground(photo: Photo, bitmap: ImageBitmap): HTMLCanvasElement {
    const cached = this.blurredCache.get(photo.id)
    if (cached) return cached

    const ratio = bitmap.width / bitmap.height
    const w = ratio >= 1 ? BLURRED_BACKGROUND_LONG_SIDE : Math.max(4, Math.round(BLURRED_BACKGROUND_LONG_SIDE * ratio))
    const h = ratio >= 1 ? Math.max(4, Math.round(BLURRED_BACKGROUND_LONG_SIDE / ratio)) : BLURRED_BACKGROUND_LONG_SIDE

    // 分兩階段縮小，讓取樣更平均、放大後更柔和
    const mid = createScratchCanvas(w * 4, h * 4)
    const midCtx = mid.getContext('2d')!
    midCtx.imageSmoothingQuality = 'high'
    midCtx.drawImage(bitmap, 0, 0, mid.width, mid.height)

    const small = createScratchCanvas(w, h)
    const smallCtx = small.getContext('2d')!
    smallCtx.imageSmoothingQuality = 'high'
    smallCtx.drawImage(mid, 0, 0, w, h)
    smallCtx.fillStyle = 'rgba(0, 0, 0, 0.32)'
    smallCtx.fillRect(0, 0, w, h)

    mid.width = 0
    mid.height = 0
    this.blurredCache.set(photo.id, small)
    return small
  }

  /**
   * 依據規格書 §3.1 繪製單張照片：
   * - 照片方向與目標框方向一致 → 填滿畫面（Cover）
   * - 不一致 → 完整顯示於中央（Contain），空白處以同一張照片放大模糊填滿（不留黑邊）
   */
  /**
   * 依使用者自訂的取景範圍繪製照片：範圍以中心為準裁成格子的比例；
   * 範圍超出照片時（縮到比照片還小）先鋪模糊背景補滿
   * @param zoomScale 額外放大倍率（片頭封面的緩慢推近用）
   */
  private drawPhotoCropped(
    ctx: CanvasRenderingContext2D,
    photo: Photo,
    bitmap: ImageBitmap,
    destX: number,
    destY: number,
    destW: number,
    destH: number,
    zoomScale = 1
  ): void {
    if (!photo.crop) return
    const image = { width: bitmap.width, height: bitmap.height }
    const fitted = fitCropToAspect(photo.crop, image, destW / destH)
    const z = Math.max(1, zoomScale)
    const rect = {
      x: fitted.x + (fitted.w - fitted.w / z) / 2,
      y: fitted.y + (fitted.h - fitted.h / z) / 2,
      w: fitted.w / z,
      h: fitted.h / z
    }
    const scale = destW / rect.w

    ctx.save()
    ctx.beginPath()
    ctx.rect(destX, destY, destW, destH)
    ctx.clip()
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    if (cropExceedsImage(rect, image)) {
      drawImageCover(ctx, this.getBlurredBackground(photo, bitmap), destX, destY, destW, destH, 1.1)
      ctx.shadowColor = 'rgba(0, 0, 0, 0.45)'
      ctx.shadowBlur = 24
    }
    ctx.drawImage(bitmap, destX - rect.x * scale, destY - rect.y * scale, image.width * scale, image.height * scale)
    ctx.restore()
  }

  /** 拼圖格子內的照片：有自訂取景就依取景，否則填滿格子 */
  private drawTilePhoto(
    ctx: CanvasRenderingContext2D,
    photo: Photo,
    bitmap: ImageBitmap,
    x: number,
    y: number,
    w: number,
    h: number
  ): void {
    if (photo.crop) this.drawPhotoCropped(ctx, photo, bitmap, x, y, w, h)
    else drawImageCover(ctx, bitmap, x, y, w, h, 1)
  }

  private drawPhotoAdaptive(
    ctx: CanvasRenderingContext2D,
    photo: Photo,
    bitmap: ImageBitmap,
    destX: number,
    destY: number,
    destW: number,
    destH: number,
    zoomScale: number,
    forceCover: boolean
  ): void {
    // 使用者在放大檢視中自訂過取景：一律依取景範圍繪製
    if (photo.crop) {
      this.drawPhotoCropped(ctx, photo, bitmap, destX, destY, destW, destH, zoomScale)
      return
    }

    const isPhotoLandscape = bitmap.width >= bitmap.height
    const isBoxLandscape = destW >= destH

    if (forceCover || isPhotoLandscape === isBoxLandscape) {
      drawImageCover(ctx, bitmap, destX, destY, destW, destH, zoomScale)
      return
    }

    // 方向不一致：先畫預先模糊的放大背景，再於中央完整顯示前景照片
    ctx.save()
    ctx.beginPath()
    ctx.rect(destX, destY, destW, destH)
    ctx.clip()

    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    drawImageCover(ctx, this.getBlurredBackground(photo, bitmap), destX, destY, destW, destH, 1.1)

    const imgRatio = bitmap.width / bitmap.height
    const boxRatio = destW / destH
    let fgW: number
    let fgH: number
    if (imgRatio > boxRatio) {
      fgW = destW
      fgH = destW / imgRatio
    } else {
      fgH = destH
      fgW = destH * imgRatio
    }
    fgW *= zoomScale
    fgH *= zoomScale

    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)'
    ctx.shadowBlur = 24
    ctx.drawImage(bitmap, destX + (destW - fgW) / 2, destY + (destH - fgH) / 2, fgW, fgH)
    ctx.restore()
  }

  /**
   * 預先解碼指定時間點之後即將出現的照片（預覽播放時避免切換瞬間卡頓）
   */
  prefetchUpcomingPhotos(journey: Journey, timeline: Segment[], globalTimeMs: number): void {
    const pos = locateTimelinePosition(timeline, globalTimeMs)
    if (!pos) return
    const ids: string[] = []
    for (let i = pos.segmentIndex; i < timeline.length && ids.length < 4; i++) {
      const seg = timeline[i]
      if (seg.type !== 'STATION') continue
      for (const cell of seg.cells) {
        ids.push(...cell.photoIds)
        if (ids.length >= 4) break
      }
    }
    for (const id of ids) {
      const photo = journey.photos[id]
      if (photo && !this.bitmapCache.has(id)) void this.getPhotoBitmap(photo)
    }
  }

  /**
   * 釋放所有快取的影像資源
   */
  disposeBitmaps(): void {
    for (const bmp of this.bitmapCache.values()) {
      bmp.close()
    }
    this.bitmapCache.clear()
    this.avatarCache?.bitmap?.close()
    this.avatarCache = null
    this.blurredCache.clear()
    this.outgoingSnapshot = null
    this.mapBlurCanvas = null
  }

  /**
   * 根據全域時間戳（毫秒）渲染完整的一幀畫面
   * @param waitForMapTiles 是否等待地圖圖磚就緒（輸出 MP4 時為 true，即時預覽時為 false）
   */
  async renderFrameAtTime(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    journey: Journey,
    timeline: Segment[],
    globalTimeMs: number,
    mapRenderer: DeterministicMapRenderer,
    waitForMapTiles: boolean
  ): Promise<void> {
    const pos = locateTimelinePosition(timeline, globalTimeMs)
    if (!pos) {
      ctx.fillStyle = '#0f172a'
      ctx.fillRect(0, 0, width, height)
      return
    }

    const { segmentIndex, segmentElapsedMs } = pos
    const inCrossfade = segmentIndex > 0 && segmentElapsedMs < TRANSITION_FADE_MS

    // 交叉淡化：先準備前一段落最後一幀（每個段落交界只算一次）
    let outgoing: HTMLCanvasElement | null = null
    if (inCrossfade) {
      outgoing = await this.getOutgoingSnapshot(
        width,
        height,
        journey,
        timeline,
        segmentIndex - 1,
        mapRenderer,
        waitForMapTiles
      )
    }

    await this.renderSegment(
      ctx,
      width,
      height,
      journey,
      timeline,
      segmentIndex,
      segmentElapsedMs,
      mapRenderer,
      waitForMapTiles
    )

    if (outgoing) {
      ctx.save()
      ctx.globalAlpha = 1 - segmentElapsedMs / TRANSITION_FADE_MS
      ctx.drawImage(outgoing, 0, 0, width, height)
      ctx.restore()
    }
  }

  private async getOutgoingSnapshot(
    width: number,
    height: number,
    journey: Journey,
    timeline: Segment[],
    index: number,
    mapRenderer: DeterministicMapRenderer,
    waitForMapTiles: boolean
  ): Promise<HTMLCanvasElement> {
    const snap = this.outgoingSnapshot
    if (snap && snap.timeline === timeline && snap.index === index && snap.width === width && snap.height === height) {
      return snap.canvas
    }

    const canvas = snap && snap.width === width && snap.height === height ? snap.canvas : createScratchCanvas(width, height)
    const snapCtx = canvas.getContext('2d')!
    const seg = timeline[index]
    await this.renderSegment(
      snapCtx,
      width,
      height,
      journey,
      timeline,
      index,
      seg.durationMs,
      mapRenderer,
      waitForMapTiles
    )
    this.outgoingSnapshot = { timeline, index, width, height, canvas }
    return canvas
  }

  private async renderSegment(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    journey: Journey,
    timeline: Segment[],
    segmentIndex: number,
    segmentElapsedMs: number,
    mapRenderer: DeterministicMapRenderer,
    waitForMapTiles: boolean
  ): Promise<void> {
    const segment = timeline[segmentIndex]
    const t = segment.durationMs > 0 ? Math.min(1, segmentElapsedMs / segment.durationMs) : 1

    ctx.save()
    ctx.fillStyle = '#0f172a'
    ctx.fillRect(0, 0, width, height)
    ctx.restore()

    switch (segment.type) {
      case 'INTRO':
        await this.renderIntroSegment(ctx, width, height, journey, t)
        break
      case 'OPENING_LOCATOR':
        await this.renderOpeningLocatorSegment(ctx, width, height, journey, segment, t, mapRenderer, waitForMapTiles)
        break
      case 'STATION':
        await this.renderStationSegment(ctx, width, height, journey, segment, segmentElapsedMs)
        break
      case 'MOVE':
        await this.renderMoveSegment(ctx, width, height, journey, timeline, segmentIndex, segment, t, mapRenderer, waitForMapTiles)
        break
      case 'OUTRO':
        await this.renderOutroSegment(ctx, width, height, journey, timeline, segment, t, mapRenderer, waitForMapTiles)
        break
    }
  }

  /**
   * 將目前地圖畫面繪入主畫布
   */
  private drawMapCanvas(ctx: CanvasRenderingContext2D, mapRenderer: DeterministicMapRenderer, width: number, height: number): void {
    const mapCanvas = mapRenderer.getCanvas()
    if (mapCanvas && mapCanvas.width > 0) {
      ctx.drawImage(mapCanvas, 0, 0, width, height)
    }
  }

  /**
   * 渲染片頭（3 秒）：封面照片填滿畫面、上下暗色漸層、疊上旅程標題與日期範圍；封面照片緩慢放大、文字淡入
   */
  private async renderIntroSegment(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    journey: Journey,
    t: number
  ): Promise<void> {
    const coverPhoto = resolveCoverPhoto(journey)
    const zoom = 1.0 + 0.08 * t

    if (coverPhoto) {
      const bmp = await this.getPhotoBitmap(coverPhoto)
      if (bmp) {
        this.drawPhotoAdaptive(ctx, coverPhoto, bmp, 0, 0, width, height, zoom, true)
      }
    }

    const topGrad = ctx.createLinearGradient(0, 0, 0, height * 0.35)
    topGrad.addColorStop(0, 'rgba(0, 0, 0, 0.55)')
    topGrad.addColorStop(1, 'rgba(0, 0, 0, 0)')
    ctx.fillStyle = topGrad
    ctx.fillRect(0, 0, width, height * 0.35)

    const botGrad = ctx.createLinearGradient(0, height * 0.45, 0, height)
    botGrad.addColorStop(0, 'rgba(0, 0, 0, 0)')
    botGrad.addColorStop(1, 'rgba(0, 0, 0, 0.72)')
    ctx.fillStyle = botGrad
    ctx.fillRect(0, height * 0.45, width, height * 0.55)

    this.drawCenteredTitle(ctx, width, height, journey, Math.min(1, t / 0.35))
  }

  /**
   * 畫面中央的旅程標題＋日期範圍（片頭與片尾共用）
   */
  private drawCenteredTitle(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    journey: Journey,
    alpha: number
  ): void {
    if (alpha <= 0) return
    const scale = Math.max(0.65, Math.min(width, height) / 1080)
    const dateRangeStr = formatJourneyDateRange(
      Object.values(journey.photos)
        .filter((p) => p.included)
        .map((p) => p.localDate)
    )

    ctx.save()
    ctx.globalAlpha = alpha
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.shadowColor = 'rgba(0, 0, 0, 0.65)'
    ctx.shadowBlur = 18

    const titleSize = Math.round(72 * scale)
    ctx.font = `700 ${titleSize}px ${DEFAULT_VISUAL_THEME.fontFamily}`
    ctx.fillStyle = DEFAULT_VISUAL_THEME.typography.primaryTextColor
    ctx.fillText(
      fitTextToWidth(ctx, journey.title || '我的旅遊回憶', width * 0.88),
      width / 2,
      height / 2 - 16 * scale
    )

    if (dateRangeStr) {
      const dateSize = Math.round(36 * scale)
      ctx.font = `500 ${dateSize}px ${DEFAULT_VISUAL_THEME.fontFamily}`
      ctx.fillStyle = DEFAULT_VISUAL_THEME.typography.secondaryTextColor
      ctx.fillText(dateRangeStr, width / 2, height / 2 + 54 * scale)
    }
    ctx.restore()
  }

  /**
   * 渲染開場定位段（3 秒）：地圖先框住整個旅程所有站點，再推近到第一個站點並彈出地名氣泡
   */
  private async renderOpeningLocatorSegment(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    journey: Journey,
    segment: Extract<Segment, { type: 'OPENING_LOCATOR' }>,
    t: number,
    mapRenderer: DeterministicMapRenderer,
    waitForMapTiles: boolean
  ): Promise<void> {
    const activeStations = getActiveStations(journey)
    mapRenderer.setCamera(cameraAt(segment, t, activeStations, { width, height }))
    await mapRenderer.renderNow(waitForMapTiles)
    this.drawMapCanvas(ctx, mapRenderer, width, height)

    const firstStation =
      activeStations.find((s) => s.id === segment.firstStationId) ?? activeStations[0]

    for (const st of activeStations) {
      const pt = mapRenderer.project(st.center)
      const isFirst = st.id === firstStation?.id
      drawStationMarker(ctx, pt.x, pt.y, isFirst ? 1.15 : 0.85, isFirst, t * 3)
    }

    if (firstStation && t >= 0.65) {
      const pt = mapRenderer.project(firstStation.center)
      drawPlaceBubble(ctx, pt.x, pt.y, getStationDisplayName(firstStation), Math.min(1, (t - 0.65) / 0.25), width, height)
    }

    drawMapAttribution(ctx, width, height)
  }

  /**
   * 渲染站點段：由展示格組成（單張或 2~3 張拼圖），格內照片各自緩慢放大 1.0 → 1.08，
   * 格與格之間 0.5 秒淡入淡出，左下角顯示三行文字
   */
  private async renderStationSegment(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    journey: Journey,
    segment: Extract<Segment, { type: 'STATION' }>,
    segmentElapsedMs: number
  ): Promise<void> {
    const station = journey.stations.find((s) => s.id === segment.stationId)
    if (!station || segment.cells.length === 0) return

    let accMs = 0
    let cellIdx = segment.cells.length - 1
    let cellElapsedMs = segment.cells[cellIdx].durationMs

    for (let i = 0; i < segment.cells.length; i++) {
      const cell = segment.cells[i]
      if (segmentElapsedMs < accMs + cell.durationMs) {
        cellIdx = i
        cellElapsedMs = Math.max(0, segmentElapsedMs - accMs)
        break
      }
      accMs += cell.durationMs
    }

    const currentCell = segment.cells[cellIdx]
    const cellProgress = currentCell.durationMs > 0 ? Math.min(1, cellElapsedMs / currentCell.durationMs) : 1

    await this.drawDisplayCell(ctx, width, height, journey, currentCell, cellProgress, 1, 0)

    // 格與格之間最後 0.5 秒疊加下一格淡入
    const remainingMs = currentCell.durationMs - cellElapsedMs
    const nextCell = cellIdx < segment.cells.length - 1 ? segment.cells[cellIdx + 1] : undefined
    const nextAlpha = nextCell && remainingMs < TRANSITION_FADE_MS ? 1 - remainingMs / TRANSITION_FADE_MS : 0
    if (nextCell && nextAlpha > 0) {
      await this.drawDisplayCell(ctx, width, height, journey, nextCell, 0, nextAlpha, 1)
    }

    drawBottomGradientMask(ctx, width, height)

    // 文字層隨格子交叉淡化，避免日期／備註瞬間跳換
    const currentText = resolveDisplayCellOverlayText(currentCell, journey.photos, getStationDisplayName(station), station.note)
    if (nextCell && nextAlpha > 0) {
      const nextText = resolveDisplayCellOverlayText(nextCell, journey.photos, getStationDisplayName(station), station.note)
      const sameText =
        nextText.line2Date === currentText.line2Date && (nextText.line3Note ?? '') === (currentText.line3Note ?? '')
      if (sameText) {
        this.drawStationCaption(ctx, width, height, currentText, 1)
      } else {
        this.drawStationCaption(ctx, width, height, currentText, 1 - nextAlpha)
        this.drawStationCaption(ctx, width, height, nextText, nextAlpha)
      }
    } else {
      this.drawStationCaption(ctx, width, height, currentText, 1)
    }
  }

  /**
   * 站點段左下角三行文字 (§2.3)
   */
  private drawStationCaption(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    text: { line1Title: string; line2Date: string; line3Note?: string },
    alpha: number
  ): void {
    if (alpha <= 0.01) return
    const scale = Math.max(0.65, Math.min(width, height) / 1080)
    const padLeft = Math.round(56 * scale)
    const maxTextWidth = width - padLeft * 2
    let cursorBottomY = height - Math.round(52 * scale)

    ctx.save()
    ctx.globalAlpha = alpha
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.shadowColor = 'rgba(0, 0, 0, 0.7)'
    ctx.shadowBlur = 12

    if (text.line3Note) {
      ctx.font = `500 ${Math.round(34 * scale)}px ${DEFAULT_VISUAL_THEME.fontFamily}`
      ctx.fillStyle = DEFAULT_VISUAL_THEME.typography.secondaryTextColor
      ctx.fillText(fitTextToWidth(ctx, text.line3Note, maxTextWidth), padLeft, cursorBottomY)
      cursorBottomY -= Math.round(50 * scale)
    }

    if (text.line2Date) {
      ctx.font = `600 ${Math.round(34 * scale)}px ${DEFAULT_VISUAL_THEME.fontFamily}`
      ctx.fillStyle = DEFAULT_VISUAL_THEME.typography.accentTextColor
      ctx.fillText(text.line2Date, padLeft, cursorBottomY)
      cursorBottomY -= Math.round(58 * scale)
    }

    ctx.font = `700 ${Math.round(54 * scale)}px ${DEFAULT_VISUAL_THEME.fontFamily}`
    ctx.fillStyle = DEFAULT_VISUAL_THEME.typography.primaryTextColor
    ctx.fillText(fitTextToWidth(ctx, text.line1Title, maxTextWidth), padLeft, cursorBottomY)
    ctx.restore()
  }

  /**
   * 頁面設定視窗的即時預覽：只畫一頁（含運鏡），不畫文字
   * @param progress 頁內進度 0 ~ 1
   */
  async renderPagePreview(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    journey: Journey,
    cell: DisplayCell,
    progress: number
  ): Promise<void> {
    ctx.fillStyle = '#020617'
    ctx.fillRect(0, 0, width, height)
    await this.drawDisplayCell(ctx, width, height, journey, cell, progress, 1, 0)
  }

  /** 每頁先組合在離屏畫布上，再整頁套用運鏡；同一幀最多兩頁（目前頁＋淡入的下一頁） */
  private pageCanvases: HTMLCanvasElement[] = []

  private getPageCanvas(slot: number, width: number, height: number): HTMLCanvasElement {
    let canvas = this.pageCanvases[slot]
    if (!canvas || canvas.width !== width || canvas.height !== height) {
      canvas = createScratchCanvas(width, height)
      this.pageCanvases[slot] = canvas
    }
    return canvas
  }

  /**
   * 繪製一頁（展示格）：
   * 1. 依拼接樣式把照片組合成一整張畫面（拍立得、依序出現、連拍輪動帶有頁內動畫）
   * 2. 整頁一起套用運鏡（縮放＋平移），拼圖不會每小張各自移動
   */
  private async drawDisplayCell(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    journey: Journey,
    cell: DisplayCell,
    cellProgress: number,
    alpha: number,
    slot: number
  ): Promise<void> {
    const photos = cell.photoIds
      .map((id) => journey.photos[id])
      .filter((p): p is Photo => Boolean(p))
    if (photos.length === 0) return

    const pageCanvas = this.getPageCanvas(slot, width, height)
    const pctx = pageCanvas.getContext('2d')
    if (!pctx) return
    pctx.save()
    pctx.clearRect(0, 0, width, height)
    pctx.imageSmoothingEnabled = true
    pctx.imageSmoothingQuality = 'high'
    await this.composePage(pctx, width, height, cell, photos, cellProgress)
    pctx.restore()

    const { scale, centerOffsetX, centerOffsetY } = computeMotionTransform(cell.motion, cellProgress)
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.translate(width / 2, height / 2)
    ctx.scale(scale, scale)
    ctx.translate(-width / 2 - centerOffsetX * width, -height / 2 - centerOffsetY * height)
    ctx.drawImage(pageCanvas, 0, 0)
    ctx.restore()
  }

  /** 依拼接樣式把一頁的照片畫到離屏畫布上 */
  private async composePage(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    cell: DisplayCell,
    photos: Photo[],
    progress: number
  ): Promise<void> {
    const count = photos.length
    const ui = uiScaleFor(width, height)
    const gap = COLLAGE_GAP_PX * ui

    if (cell.layout === 'single' || count === 1) {
      const bmp = await this.getPhotoBitmap(photos[0])
      if (bmp) this.drawPhotoAdaptive(ctx, photos[0], bmp, 0, 0, width, height, 1, false)
      return
    }

    if (cell.layout === 'burst') {
      // 連拍輪動：依進度輪流顯示，每次換張時帶一下快門閃白
      const exact = Math.min(count - 0.0001, progress * count)
      const idx = Math.floor(exact)
      const bmp = await this.getPhotoBitmap(photos[idx])
      // 預先解碼下一張，避免換張時卡頓
      if (idx + 1 < count) void this.getPhotoBitmap(photos[idx + 1])
      if (bmp) this.drawPhotoAdaptive(ctx, photos[idx], bmp, 0, 0, width, height, 1, false)
      const sinceSwitch = exact - idx
      if (idx > 0 && sinceSwitch < 0.18) {
        ctx.fillStyle = `rgba(255, 255, 255, ${0.28 * (1 - sinceSwitch / 0.18)})`
        ctx.fillRect(0, 0, width, height)
      }
      return
    }

    const bitmaps = await Promise.all(photos.map((p) => this.getPhotoBitmap(p)))

    if (cell.layout === 'polaroid') {
      this.composePolaroids(ctx, width, height, photos, bitmaps, progress, cell.seed, ui)
      return
    }

    ctx.fillStyle = '#0f172a'
    ctx.fillRect(0, 0, width, height)

    if (cell.layout === 'reveal') {
      // 依序出現：宮格中一張張浮現（前 55% 的時間內全部到位）
      const rects = computeTileRects('grid', count, width, height, gap)
      for (let i = 0; i < count; i++) {
        const bmp = bitmaps[i]
        if (!bmp) continue
        const start = (i / count) * 0.55
        const local = i === 0 && progress === 0 ? 1 : Math.max(0, Math.min(1, (progress - start) / 0.2))
        if (local <= 0) continue
        const eased = 1 - Math.pow(1 - local, 3)
        const r = rects[i]
        const lift = (1 - eased) * r.h * 0.08
        const shrink = 0.94 + 0.06 * eased
        ctx.save()
        ctx.globalAlpha = eased
        const w = r.w * shrink
        const h = r.h * shrink
        this.drawTilePhoto(ctx, photos[i], bmp, r.x + (r.w - w) / 2, r.y + (r.h - h) / 2 + lift, w, h)
        ctx.restore()
      }
      return
    }

    const rects = computeTileRects(cell.layout, count, width, height, gap)
    rects.forEach((r: Rect, i) => {
      const bmp = bitmaps[i]
      if (bmp) this.drawTilePhoto(ctx, photos[i], bmp, r.x, r.y, r.w, r.h)
    })
  }

  /** 拍立得：模糊背景上散放白框相片，前半段依序落下 */
  private composePolaroids(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    photos: Photo[],
    bitmaps: (ImageBitmap | null)[],
    progress: number,
    seed: number,
    ui: number
  ): void {
    const firstIdx = bitmaps.findIndex((b) => Boolean(b))
    const firstBmp = firstIdx >= 0 ? bitmaps[firstIdx] : null
    if (firstBmp) {
      drawImageCover(ctx, this.getBlurredBackground(photos[firstIdx], firstBmp), 0, 0, width, height, 1.1)
      ctx.fillStyle = 'rgba(15, 23, 42, 0.45)'
      ctx.fillRect(0, 0, width, height)
    } else {
      ctx.fillStyle = '#0f172a'
      ctx.fillRect(0, 0, width, height)
    }

    const placements = computePolaroidPlacements(photos.length, width, height, seed)
    const dropWindow = 0.45
    placements.forEach((pl, i) => {
      const bmp = bitmaps[i]
      if (!bmp) return
      // 淡入到下一頁時（progress = 0）先露出第一張，其餘依序落下
      const start = photos.length > 1 ? (i / (photos.length - 1)) * dropWindow : 0
      const appear = i === 0 && progress === 0 ? 1 : Math.max(0, Math.min(1, (progress - start) / 0.16))
      if (appear <= 0) return
      const eased = 1 - Math.pow(1 - appear, 3)
      const scale = 1.25 - 0.25 * eased

      const frame = pl.size
      const border = frame * 0.05
      const photoBox = frame - border * 2
      const bottomExtra = frame * 0.12

      ctx.save()
      ctx.globalAlpha = eased
      ctx.translate(pl.cx, pl.cy - (1 - eased) * frame * 0.08)
      ctx.rotate(pl.rotation)
      ctx.scale(scale, scale)
      ctx.shadowColor = 'rgba(0, 0, 0, 0.45)'
      ctx.shadowBlur = 24 * ui
      ctx.shadowOffsetY = 8 * ui
      ctx.fillStyle = '#fbfaf7'
      ctx.fillRect(-frame / 2, -(frame + bottomExtra) / 2, frame, frame + bottomExtra)
      ctx.shadowColor = 'transparent'
      this.drawTilePhoto(ctx, photos[i], bmp, -frame / 2 + border, -(frame + bottomExtra) / 2 + border, photoBox, photoBox)
      ctx.restore()
    })
  }

  /**
   * 渲染移動段（固定 3.5 秒，遵循 §2.4 三階段時間編排）
   */
  private async renderMoveSegment(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    journey: Journey,
    timeline: Segment[],
    currentSegmentIdx: number,
    segment: Extract<Segment, { type: 'MOVE' }>,
    t: number,
    mapRenderer: DeterministicMapRenderer,
    waitForMapTiles: boolean
  ): Promise<void> {
    const activeStations = getActiveStations(journey)
    const fromStation = activeStations.find((s) => s.id === segment.fromStationId) ?? activeStations[0]
    const toStation =
      activeStations.find((s) => s.id === segment.toStationId) ?? activeStations[activeStations.length - 1]

    if (!fromStation || !toStation) return

    const moveState = evaluateMoveSegmentAt(fromStation, toStation, t, { width, height }, segment.route)
    mapRenderer.setCamera(moveState.camera)

    // 此移動段之前已完成的路線 + 當前截取路線
    const previousRoutes: [number, number][][] = []
    for (let i = 0; i < currentSegmentIdx; i++) {
      const seg = timeline[i]
      if (seg.type === 'MOVE') previousRoutes.push(seg.route)
    }

    const activeRouteSlice = sliceRouteByProgress(segment.route, moveState.routeProgress)
    await mapRenderer.renderNow(waitForMapTiles)
    this.drawMapCanvas(ctx, mapRenderer, width, height)
    drawRouteLines(
      ctx,
      mapRenderer,
      activeRouteSlice.length >= 2 ? [...previousRoutes, activeRouteSlice] : previousRoutes,
      width,
      height
    )

    // 起點與終點標記（終點在 2.8–3.5s 回彈彈出）
    const fromPt = mapRenderer.project(fromStation.center)
    drawStationMarker(ctx, fromPt.x, fromPt.y, 1, moveState.showOriginBubble, t * 3)
    const toPt = mapRenderer.project(toStation.center)
    if (moveState.destinationMarkerScale > 0) {
      drawStationMarker(ctx, toPt.x, toPt.y, moveState.destinationMarkerScale, true, t * 4)
    }

    // 移動標記：位於路線前端，出發前停在起點、抵達後停在終點
    const ui = uiScaleFor(width, height)
    const markerStyle = journey.settings.travelerMarker ?? 'dot'
    const avatar = markerStyle === 'avatar' ? await this.getAvatarBitmap(journey.travelerAvatar) : null
    const headCoord = activeRouteSlice.length > 0 ? activeRouteSlice[activeRouteSlice.length - 1] : null
    const headPt = (headCoord ? mapRenderer.projectRoute([headCoord])[0] : undefined) ?? fromPt
    drawTravelerMarker(ctx, headPt.x, headPt.y, markerStyle, ui, t * 5.6, avatar)
    const travelerOffset = travelerMarkerRadius(markerStyle === 'avatar' && !avatar ? 'person' : markerStyle, ui)

    // 地名氣泡畫在最上層。移動標記在站點附近時（道路起訖點會吸附到最近的路，與站點中心差幾十公尺），
    // 氣泡改以移動標記為錨點並讓出它的高度，避免壓住大頭照
    const bubbleAnchor = (stationPt: { x: number; y: number }) =>
      Math.hypot(headPt.x - stationPt.x, headPt.y - stationPt.y) < travelerOffset * 3
        ? { x: headPt.x, y: Math.min(headPt.y, stationPt.y), offset: travelerOffset }
        : { x: stationPt.x, y: stationPt.y, offset: 0 }

    if (moveState.showOriginBubble) {
      const anchor = bubbleAnchor(fromPt)
      drawPlaceBubble(ctx, anchor.x, anchor.y, getStationDisplayName(fromStation), 1, width, height, anchor.offset)
    }

    if (moveState.showDestinationBubble) {
      const appear = Math.min(1, moveState.destinationMarkerScale)
      const anchor = bubbleAnchor(toPt)
      drawPlaceBubble(ctx, anchor.x, anchor.y, getStationDisplayName(toStation), appear, width, height, anchor.offset)

      // 底部字幕：「前往 [目的站點名稱]」＋目的站點的抵達日期 (§2.2)
      drawBottomGradientMask(ctx, width, height)
      const scale = Math.max(0.65, Math.min(width, height) / 1080)
      const arrivalPhoto = toStation.photoIds
        .map((id) => journey.photos[id])
        .find((p) => p && p.included && p.localDate)
      const arrivalDateStr = formatLocalDateDisplay(arrivalPhoto?.localDate)

      ctx.save()
      ctx.globalAlpha = appear
      ctx.textAlign = 'center'
      ctx.textBaseline = 'alphabetic'
      ctx.shadowColor = 'rgba(0, 0, 0, 0.7)'
      ctx.shadowBlur = 12

      ctx.font = `700 ${Math.round(52 * scale)}px ${DEFAULT_VISUAL_THEME.fontFamily}`
      ctx.fillStyle = DEFAULT_VISUAL_THEME.typography.primaryTextColor
      ctx.fillText(
        fitTextToWidth(ctx, `前往 ${getStationDisplayName(toStation)}`, width * 0.9),
        width / 2,
        height - Math.round(104 * scale)
      )

      if (arrivalDateStr) {
        ctx.font = `600 ${Math.round(34 * scale)}px ${DEFAULT_VISUAL_THEME.fontFamily}`
        ctx.fillStyle = DEFAULT_VISUAL_THEME.typography.accentTextColor
        ctx.fillText(arrivalDateStr, width / 2, height - Math.round(52 * scale))
      }
      ctx.restore()
    }

    drawMapAttribution(ctx, width, height)
  }

  /**
   * 以「縮小再放大」產生地圖模糊效果（不依賴 ctx.filter，所有瀏覽器一致）
   * @param amount 0 = 不模糊，1 = 最模糊
   */
  private drawBlurredMap(
    ctx: CanvasRenderingContext2D,
    mapRenderer: DeterministicMapRenderer,
    width: number,
    height: number,
    amount: number
  ): void {
    const mapCanvas = mapRenderer.getCanvas()
    if (!mapCanvas || mapCanvas.width === 0) return
    if (amount <= 0.02) {
      ctx.drawImage(mapCanvas, 0, 0, width, height)
      return
    }

    const factor = 1 + amount * 23 // 最多縮小到 1/24
    const w = Math.max(8, Math.round(width / factor))
    const h = Math.max(8, Math.round(height / factor))
    if (!this.mapBlurCanvas) this.mapBlurCanvas = createScratchCanvas(w, h)
    const blurCanvas = this.mapBlurCanvas
    if (blurCanvas.width !== w || blurCanvas.height !== h) {
      blurCanvas.width = w
      blurCanvas.height = h
    }
    const blurCtx = blurCanvas.getContext('2d')!
    blurCtx.imageSmoothingQuality = 'high'
    blurCtx.drawImage(mapCanvas, 0, 0, w, h)

    ctx.save()
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    // 先畫清晰地圖墊底，再疊上模糊版本，讓模糊程度平滑過渡
    ctx.drawImage(mapCanvas, 0, 0, width, height)
    ctx.globalAlpha = Math.min(1, amount * 1.6)
    ctx.drawImage(blurCanvas, 0, 0, width, height)
    ctx.restore()
  }

  /**
   * 渲染片尾（4 秒）：從最後一個站點拉遠至整條旅程路線（所有站點標記可見、最後一站突出），
   * 地圖逐漸模糊變暗，中央浮現旅程標題與日期範圍（不畫回程線）
   */
  private async renderOutroSegment(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    journey: Journey,
    timeline: Segment[],
    segment: Extract<Segment, { type: 'OUTRO' }>,
    t: number,
    mapRenderer: DeterministicMapRenderer,
    waitForMapTiles: boolean
  ): Promise<void> {
    const activeStations = getActiveStations(journey)
    mapRenderer.setCamera(cameraAt(segment, t, activeStations, { width, height }))
    await mapRenderer.renderNow(waitForMapTiles)

    const blurProgress = Math.max(0, (t - 0.45) / 0.55)
    this.drawBlurredMap(ctx, mapRenderer, width, height, blurProgress)

    // 整條旅程路線（不畫回程線），隨地圖一起淡出
    ctx.save()
    ctx.globalAlpha = 1 - blurProgress * 0.6
    drawRouteLines(
      ctx,
      mapRenderer,
      timeline
        .filter((s): s is Extract<Segment, { type: 'MOVE' }> => s.type === 'MOVE')
        .map((s) => s.route),
      width,
      height
    )
    ctx.restore()

    const lastStation = activeStations[activeStations.length - 1]
    ctx.save()
    ctx.globalAlpha = 1 - blurProgress * 0.6
    for (const st of activeStations) {
      const pt = mapRenderer.project(st.center)
      const isLast = st.id === lastStation?.id
      drawStationMarker(ctx, pt.x, pt.y, isLast ? 1.3 : 0.9, isLast, t * 3)
    }
    ctx.restore()

    drawMapAttribution(ctx, width, height, 1 - blurProgress)

    if (blurProgress > 0) {
      ctx.save()
      ctx.fillStyle = `rgba(15, 23, 42, ${(blurProgress * 0.62).toFixed(3)})`
      ctx.fillRect(0, 0, width, height)
      ctx.restore()
      this.drawCenteredTitle(ctx, width, height, journey, blurProgress)
    }
  }
}
