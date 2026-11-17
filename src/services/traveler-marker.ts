import type { TravelerMarkerStyle } from '../types/journey'

/** 圓點樣式的主色（與黃色站點標記區隔） */
const TRAVELER_COLOR = '#2563EB'

/** 各樣式在 1080p 畫面上的半徑（像素），實際繪製時再乘上畫面比例 */
const BASE_RADIUS: Record<TravelerMarkerStyle, number> = {
  dot: 16,
  person: 38,
  avatar: 56
}

/**
 * 移動標記在畫面上的外半徑（含白框），用來決定地名氣泡要往上讓多少
 * @param style 標記樣式
 * @param uiScale 畫面比例（1080p = 1）
 */
export function travelerMarkerRadius(style: TravelerMarkerStyle, uiScale: number): number {
  return BASE_RADIUS[style] * uiScale
}

/**
 * 繪製小人圖示（24×24 座標系，原創線條），雙腿與手臂依 phase 前後擺動
 */
function drawWalkingFigure(ctx: CanvasRenderingContext2D, size: number, phase: number): void {
  const swing = Math.sin(phase * Math.PI * 2)
  const unit = size / 24
  ctx.save()
  ctx.scale(unit, unit)
  ctx.translate(-12, -12)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 2.6
  ctx.strokeStyle = TRAVELER_COLOR
  ctx.fillStyle = TRAVELER_COLOR

  // 頭
  ctx.beginPath()
  ctx.arc(13, 4.2, 2.4, 0, Math.PI * 2)
  ctx.fill()

  // 身體（微微前傾）
  ctx.beginPath()
  ctx.moveTo(12.6, 8.2)
  ctx.lineTo(11.4, 14.2)
  ctx.stroke()

  // 手臂：與腿反向擺動
  ctx.beginPath()
  ctx.moveTo(12.4, 9.4)
  ctx.lineTo(12.4 + 3.4 * -swing, 12.6)
  ctx.moveTo(12.4, 9.4)
  ctx.lineTo(12.4 + 3.4 * swing, 12.6)
  ctx.stroke()

  // 雙腿：以臀部為支點前後擺動
  const hipX = 11.4
  const hipY = 14.2
  for (const dir of [1, -1]) {
    const angle = 0.5 * swing * dir
    ctx.beginPath()
    ctx.moveTo(hipX, hipY)
    ctx.lineTo(hipX + Math.sin(angle) * 7, hipY + Math.cos(angle) * 7)
    ctx.stroke()
  }
  ctx.restore()
}

/**
 * 在路線前端繪製移動標記
 * @param ctx 主畫布
 * @param x 標記中心 x
 * @param y 標記中心 y
 * @param style 標記樣式：dot 圓點、person 小人、avatar 圓形大頭照（沒有大頭照時改畫小人）
 * @param uiScale 畫面比例（1080p = 1）
 * @param phase 動畫相位（遞增的數值，用於呼吸與走路擺動）
 * @param avatar 已解碼的大頭照
 */
export function drawTravelerMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  style: TravelerMarkerStyle,
  uiScale: number,
  phase: number,
  avatar?: ImageBitmap | null
): void {
  const effectiveStyle: TravelerMarkerStyle = style === 'avatar' && !avatar ? 'person' : style
  const radius = travelerMarkerRadius(effectiveStyle, uiScale)

  ctx.save()

  if (effectiveStyle === 'dot') {
    const halo = radius * (1.6 + 0.3 * Math.sin(phase * Math.PI * 2))
    ctx.beginPath()
    ctx.arc(x, y, halo, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(37, 99, 235, 0.25)'
    ctx.fill()

    ctx.shadowColor = 'rgba(15, 23, 42, 0.35)'
    ctx.shadowBlur = 10 * uiScale
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.fillStyle = '#FFFFFF'
    ctx.fill()
    ctx.shadowColor = 'transparent'

    ctx.beginPath()
    ctx.arc(x, y, radius * 0.68, 0, Math.PI * 2)
    ctx.fillStyle = TRAVELER_COLOR
    ctx.fill()
    ctx.restore()
    return
  }

  // 小人與大頭照共用：白色圓底＋陰影＋藍色外框
  ctx.shadowColor = 'rgba(15, 23, 42, 0.4)'
  ctx.shadowBlur = 16 * uiScale
  ctx.shadowOffsetY = 4 * uiScale
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.fillStyle = '#FFFFFF'
  ctx.fill()
  ctx.shadowColor = 'transparent'

  if (effectiveStyle === 'avatar' && avatar) {
    const inner = radius - 5 * uiScale
    ctx.save()
    ctx.beginPath()
    ctx.arc(x, y, inner, 0, Math.PI * 2)
    ctx.clip()
    ctx.drawImage(avatar, x - inner, y - inner, inner * 2, inner * 2)
    ctx.restore()
  } else {
    ctx.save()
    ctx.translate(x, y)
    drawWalkingFigure(ctx, radius * 1.3, phase * 2)
    ctx.restore()
  }

  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.lineWidth = 3 * uiScale
  ctx.strokeStyle = TRAVELER_COLOR
  ctx.stroke()
  ctx.restore()
}
