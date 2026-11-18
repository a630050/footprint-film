import type { MotionDirection, PageLayout, PageMotion } from '../types/journey'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** 運鏡時最大的縮放幅度（1.0 → 1.12） */
export const MOTION_ZOOM_AMOUNT = 0.12
/** 縮放同時平移時，兩端額外保留的放大量（讓平移在結尾仍有移動空間） */
export const MOTION_PAN_BASE_ZOOM = 0.04

const DIRECTION_VECTORS: Record<MotionDirection, [number, number]> = {
  none: [0, 0],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
  nw: [-1, -1]
}

/** 宮格的欄數與列數 */
export function gridShape(count: number, landscape: boolean): { cols: number; rows: number } {
  if (count <= 1) return { cols: 1, rows: 1 }
  if (landscape) {
    if (count === 2) return { cols: 2, rows: 1 }
    if (count === 3) return { cols: 3, rows: 1 }
    if (count === 4) return { cols: 2, rows: 2 }
    if (count <= 6) return { cols: 3, rows: 2 }
    if (count <= 8) return { cols: 4, rows: 2 }
    return { cols: 3, rows: 3 }
  }
  if (count === 2) return { cols: 1, rows: 2 }
  if (count === 3) return { cols: 1, rows: 3 }
  if (count === 4) return { cols: 2, rows: 2 }
  if (count <= 6) return { cols: 2, rows: 3 }
  if (count <= 8) return { cols: 2, rows: 4 }
  return { cols: 3, rows: 3 }
}

/** 均分一個矩形為 n 欄（vertical=false）或 n 列（vertical=true） */
function splitEven(area: Rect, n: number, vertical: boolean, gap: number): Rect[] {
  const rects: Rect[] = []
  if (vertical) {
    const h = (area.h - gap * (n - 1)) / n
    for (let i = 0; i < n; i++) rects.push({ x: area.x, y: area.y + i * (h + gap), w: area.w, h })
  } else {
    const w = (area.w - gap * (n - 1)) / n
    for (let i = 0; i < n; i++) rects.push({ x: area.x + i * (w + gap), y: area.y, w, h: area.h })
  }
  return rects
}

/** 宮格：最後一列不滿時，該列照片拉寬填滿整列 */
export function gridRects(count: number, width: number, height: number, gap: number): Rect[] {
  const { cols, rows } = gridShape(count, width >= height)
  const rowRects = splitEven({ x: 0, y: 0, w: width, h: height }, rows, true, gap)
  const rects: Rect[] = []
  let remaining = count
  for (let r = 0; r < rows && remaining > 0; r++) {
    const inRow = r === rows - 1 ? remaining : Math.min(cols, remaining)
    rects.push(...splitEven(rowRects[r], inRow, false, gap))
    remaining -= inRow
  }
  return rects
}

/**
 * 依拼接樣式計算每張照片的格子位置（拍立得與連拍輪動不使用）
 */
export function computeTileRects(
  layout: PageLayout,
  count: number,
  width: number,
  height: number,
  gap: number
): Rect[] {
  const full: Rect = { x: 0, y: 0, w: width, h: height }
  if (count <= 1) return [full]
  switch (layout) {
    case 'columns':
      return splitEven(full, count, false, gap)
    case 'rows':
      return splitEven(full, count, true, gap)
    case 'feature-left': {
      const bigW = (width - gap) * 0.6
      const big: Rect = { x: 0, y: 0, w: bigW, h: height }
      const rest = splitEven({ x: bigW + gap, y: 0, w: width - bigW - gap, h: height }, count - 1, true, gap)
      return [big, ...rest]
    }
    case 'feature-top': {
      const bigH = (height - gap) * 0.6
      const big: Rect = { x: 0, y: 0, w: width, h: bigH }
      const rest = splitEven({ x: 0, y: bigH + gap, w: width, h: height - bigH - gap }, count - 1, false, gap)
      return [big, ...rest]
    }
    default:
      return gridRects(count, width, height, gap)
  }
}

/** 0 ~ 1 的固定亂數序列（mulberry32），同一個 seed 永遠得到同樣結果 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface PolaroidPlacement {
  cx: number
  cy: number
  size: number // 相框外框的邊長（正方形相框）
  rotation: number // 弧度
}

/** 拍立得：依宮格大致排列，再加上固定亂數的位移與傾斜，看起來像隨手散放 */
export function computePolaroidPlacements(count: number, width: number, height: number, seed: number): PolaroidPlacement[] {
  const rand = seededRandom(seed)
  const { cols, rows } = gridShape(count, width >= height)
  const cellW = width / cols
  const cellH = height / rows
  const size = Math.min(cellW, cellH) * (count <= 2 ? 0.78 : 0.86)
  const placements: PolaroidPlacement[] = []
  for (let i = 0; i < count; i++) {
    const r = Math.floor(i / cols)
    const inRow = r === rows - 1 ? count - r * cols : cols
    const c = i - r * cols
    const rowOffset = (cols - inRow) * cellW * 0.5
    placements.push({
      cx: rowOffset + (c + 0.5) * cellW + (rand() - 0.5) * cellW * 0.16,
      cy: (r + 0.5) * cellH + (rand() - 0.5) * cellH * 0.16,
      size,
      rotation: ((rand() - 0.5) * 16 * Math.PI) / 180
    })
  }
  return placements
}

/** 緩動：線性與 ease-in-out sine 各半，開頭結尾柔和但不會停住 */
export function easeMotion(progress: number): number {
  const p = Math.max(0, Math.min(1, progress))
  return 0.5 * p + 0.5 * (0.5 - Math.cos(Math.PI * p) / 2)
}

/**
 * 計算整頁運鏡在進度 progress 時的縮放與鏡頭中心位移（以畫面比例表示）。
 * 位移永遠不超過放大後多出來的邊界，畫面四周不會露出空白。
 * 方向代表「鏡頭往哪裡移動」：例如 e = 鏡頭往右看，畫面內容往左滑。
 */
export function computeMotionTransform(
  motion: PageMotion,
  progress: number
): { scale: number; centerOffsetX: number; centerOffsetY: number } {
  const e = easeMotion(progress)
  const [dx, dy] = DIRECTION_VECTORS[motion.direction]
  const hasPan = dx !== 0 || dy !== 0

  // 起訖縮放：純縮放從原尺寸開始／回到原尺寸；
  // 縮放加平移時兩端都保留一點放大，結尾才有空間繼續往同方向移動（不會被拉回中心）
  const base = hasPan ? MOTION_PAN_BASE_ZOOM : 0
  let startScale = 1
  let endScale = 1
  if (motion.zoom === 'in') {
    startScale = 1 + base
    endScale = 1 + base + MOTION_ZOOM_AMOUNT
  } else if (motion.zoom === 'out') {
    startScale = 1 + base + MOTION_ZOOM_AMOUNT
    endScale = 1 + base
  } else if (hasPan) {
    startScale = endScale = 1 + MOTION_ZOOM_AMOUNT * 0.75
  }
  const scale = startScale + (endScale - startScale) * e

  // 鏡頭中心從起點邊界等速（依緩動）移到終點邊界，全程單向前進。
  // 放大後的邊界 slack 隨縮放呈凹函數，直線內插必定落在邊界內，畫面四周不會露出空白
  const slackOf = (s: number) => (1 - 1 / s) / 2
  const offset = -slackOf(startScale) + (slackOf(startScale) + slackOf(endScale)) * e
  return {
    scale,
    centerOffsetX: dx * offset,
    centerOffsetY: dy * offset
  }
}
