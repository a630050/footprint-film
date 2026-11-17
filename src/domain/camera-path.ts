import {
  CAMERA_FIT_PADDING_RATIO,
  MAX_CAMERA_FIT_ZOOM,
  MAX_MOVE_FIT_ZOOM,
  MOVE_FIT_PADDING
} from '../constants/video-config'
import type { CameraState, Coordinates, Segment, Station } from '../types/journey'

/** 單一一個站點推近時的預設縮放層級（城市街區層級） */
export const SINGLE_STATION_ZOOM = 11.5

/** MapLibre 512px 世界基準瓦片尺寸 */
const WORLD_TILE_SIZE = 512

/** van Wijk & Nuij 平滑縮放的曲率參數（與 MapLibre flyTo 預設值相同） */
const FLY_CURVE_RHO = 1.42

/** 預設畫布尺寸 */
const DEFAULT_VIEWPORT = { width: 1920, height: 1080 }

/**
 * Ease-in-out cubic 緩動函式
 * @param t 0 到 1 的進度
 */
export function easeInOutCubic(t: number): number {
  const clamped = Math.max(0, Math.min(1, t))
  return clamped < 0.5
    ? 4 * clamped * clamped * clamped
    : 1 - Math.pow(-2 * clamped + 2, 3) / 2
}

/**
 * 將經度正規化到 [-180, 180)
 */
export function normalizeLongitude(lng: number): number {
  const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180
  return wrapped === -180 && lng > 0 ? 180 : wrapped
}

/**
 * 回傳與 referenceLng 最接近的等價經度（差距不超過 180 度），用於跨換日線的連續運算
 */
export function unwrapLongitudeNear(lng: number, referenceLng: number): number {
  let result = lng
  while (result - referenceLng > 180) result -= 360
  while (result - referenceLng < -180) result += 360
  return result
}

/**
 * 將一條折線的經度展開為連續值（相鄰點差距不超過 180 度），
 * 使跨換日線的路線不會被畫成橫越整個地球的直線
 */
export function unwrapRouteLongitudes(route: [number, number][]): [number, number][] {
  if (route.length === 0) return route
  const result: [number, number][] = [[route[0][0], route[0][1]]]
  for (let i = 1; i < route.length; i++) {
    const prevLng = result[i - 1][0]
    result.push([unwrapLongitudeNear(route[i][0], prevLng), route[i][1]])
  }
  return result
}

/**
 * 求一組經度的最小涵蓋區間（考慮換日線）。回傳 west ≤ east，east 可能大於 180。
 */
export function computeLongitudeSpan(lngs: number[]): { west: number; east: number } {
  if (lngs.length === 0) return { west: 0, east: 0 }
  const sorted = lngs.map(normalizeLongitude).sort((a, b) => a - b)
  if (sorted.length === 1) return { west: sorted[0], east: sorted[0] }

  // 找出相鄰經度間最大的空隙（含首尾跨越 ±180 的空隙），涵蓋區間即為其補集
  let maxGap = sorted[0] + 360 - sorted[sorted.length - 1]
  let westIdx = 0
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1]
    if (gap > maxGap) {
      maxGap = gap
      westIdx = i
    }
  }

  const west = sorted[westIdx]
  const eastRaw = sorted[(westIdx - 1 + sorted.length) % sorted.length]
  const east = eastRaw < west ? eastRaw + 360 : eastRaw
  return { west, east }
}

/** Web Mercator：緯度 → 世界座標 y（0 ~ 1） */
function mercatorY(lat: number): number {
  const clampedLat = Math.max(-85.051129, Math.min(85.051129, lat))
  const sin = Math.sin((clampedLat * Math.PI) / 180)
  return 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)
}

/** Web Mercator：世界座標 y（0 ~ 1）→ 緯度 */
function inverseMercatorY(y: number): number {
  const n = Math.PI - 2 * Math.PI * y
  return (180 / Math.PI) * Math.atan(Math.sinh(n))
}

/**
 * 計算能同時框住多個座標點的中心與縮放層級（Web Mercator 幾何計算，考慮換日線）
 * NOTE: 依據規格書 §2.4：
 * - 四周留 25% 邊距（可用區域為畫面的 50%）
 * - 框住起訖點時，鏡頭最多推近到城市層級（MapLibre zoom ≈ 10），避免短距離移動時看到街道細節；最遠不設限
 *
 * @param points 座標陣列
 * @param viewport 畫布尺寸（預設 1920x1080）
 * @param maxZoom 最大縮放層級上限（預設 MAX_CAMERA_FIT_ZOOM = 10）
 * @param padding 留白比例：數字代表四周相同（預設 CAMERA_FIT_PADDING_RATIO = 0.25），
 *   或分別指定上、下、左右——例如上方多留給地名氣泡、下方多留給字幕
 * @returns 中心座標 [lng, lat] 與 zoom
 */
export function computeFitBoundsCamera(
  points: Coordinates[],
  viewport: { width: number; height: number } = DEFAULT_VIEWPORT,
  maxZoom: number = MAX_CAMERA_FIT_ZOOM,
  padding: number | FitPadding = CAMERA_FIT_PADDING_RATIO
): { center: [number, number]; zoom: number } {
  const pad: FitPadding =
    typeof padding === 'number' ? { top: padding, bottom: padding, side: padding } : padding
  if (points.length === 0) {
    return { center: [121.0, 23.5], zoom: 4 }
  }

  if (points.length === 1) {
    return {
      center: [points[0].longitude, points[0].latitude],
      zoom: Math.min(SINGLE_STATION_ZOOM, maxZoom)
    }
  }

  const { west, east } = computeLongitudeSpan(points.map((p) => p.longitude))
  const ys = points.map((p) => mercatorY(p.latitude))
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)

  const centerLng = normalizeLongitude((west + east) / 2)

  const lngFraction = (east - west) / 360
  const latFraction = maxY - minY

  // 扣除邊距後的可用寬高（預設四周各 25%，可用 50%）
  const effectiveWidth = viewport.width * Math.max(0.1, 1 - pad.side * 2)
  const effectiveHeight = viewport.height * Math.max(0.1, 1 - pad.top - pad.bottom)

  const zoomFromLng =
    lngFraction > 1e-9 ? Math.log2(effectiveWidth / WORLD_TILE_SIZE / lngFraction) : maxZoom
  const zoomFromLat =
    latFraction > 1e-9 ? Math.log2(effectiveHeight / WORLD_TILE_SIZE / latFraction) : maxZoom

  const rawZoom = Math.min(zoomFromLng, zoomFromLat)
  const zoom = Number(Math.max(0.5, Math.min(rawZoom, maxZoom)).toFixed(3))

  // 上下邊距不同時，內容的中心不在畫面正中央：把鏡頭中心往反方向移，讓內容落在可用區域中間
  const contentCenterFromTop = (pad.top + (1 - pad.bottom)) / 2
  const shiftPx = (contentCenterFromTop - 0.5) * viewport.height
  const worldSize = WORLD_TILE_SIZE * Math.pow(2, zoom)
  const centerY = (minY + maxY) / 2 - shiftPx / worldSize

  return {
    center: [centerLng, inverseMercatorY(centerY)],
    zoom
  }
}

/** 框選留白比例（相對於畫面寬高） */
export interface FitPadding {
  top: number
  bottom: number
  side: number
}

/**
 * 以 van Wijk & Nuij「平滑縮放與平移」公式（即 MapLibre flyTo 內部採用的公式）計算兩個鏡頭間的插值：
 * 先拉遠、再平移、再推近，畫面上的移動速度在整段過程中保持一致，不會在高縮放層級時出現「甩過去」的感覺。
 * 本函式為純函式，可逐幀呼叫，結果與真實時間無關（ADR 0001）。
 *
 * @param from 起始鏡頭
 * @param to 目標鏡頭
 * @param progress 0 到 1 的原始進度（內部會套用 ease-in-out cubic）
 * @param maxZoom 允許的最大縮放層級
 * @param viewport 畫布尺寸（決定「視野寬度」w0）
 */
export function interpolateCameraSmooth(
  from: { center: [number, number]; zoom: number },
  to: { center: [number, number]; zoom: number },
  progress: number,
  maxZoom = SINGLE_STATION_ZOOM,
  viewport: { width: number; height: number } = DEFAULT_VIEWPORT
): CameraState {
  const k = easeInOutCubic(progress)

  const fromLng = from.center[0]
  const toLng = unwrapLongitudeNear(to.center[0], fromLng)
  const z0 = from.zoom
  const z1 = to.zoom

  // 以起始縮放層級的世界像素座標計算
  const worldSize0 = WORLD_TILE_SIZE * Math.pow(2, z0)
  const p0x = ((fromLng + 180) / 360) * worldSize0
  const p0y = mercatorY(from.center[1]) * worldSize0
  const p1x = ((toLng + 180) / 360) * worldSize0
  const p1y = mercatorY(to.center[1]) * worldSize0
  const dx = p1x - p0x
  const dy = p1y - p0y

  const rho = FLY_CURVE_RHO
  const rho2 = rho * rho
  const w0 = Math.max(viewport.width, viewport.height)
  const w1 = w0 / Math.pow(2, z1 - z0)
  const u1 = Math.hypot(dx, dy)

  const r = (i: 0 | 1) => {
    const b = (w1 * w1 - w0 * w0 + (i ? -1 : 1) * rho2 * rho2 * u1 * u1) / (2 * (i ? w1 : w0) * rho2 * u1)
    return Math.log(Math.sqrt(b * b + 1) - b)
  }

  let scaleAt: (s: number) => number
  let travelAt: (s: number) => number
  let S: number

  const r0 = u1 > 1e-6 ? r(0) : 0
  const candidateS = u1 > 1e-6 ? (r(1) - r0) / rho : Number.NaN

  if (u1 < 1e-6 || !Number.isFinite(candidateS)) {
    // 中心點幾乎不動：只做縮放
    if (Math.abs(w0 - w1) < 1e-6) {
      return {
        center: [normalizeLongitude(fromLng), from.center[1]],
        zoom: Number(Math.min(maxZoom, z0).toFixed(3)),
        bearing: 0,
        pitch: 0
      }
    }
    const dir = w1 < w0 ? -1 : 1
    S = Math.abs(Math.log(w1 / w0)) / rho
    travelAt = () => 0
    scaleAt = (s) => 1 / Math.exp(dir * rho * s)
  } else {
    S = candidateS
    travelAt = (s) => (w0 * ((Math.cosh(r0) * Math.tanh(r0 + rho * s) - Math.sinh(r0)) / rho2)) / u1
    scaleAt = (s) => Math.cosh(r0 + rho * s) / Math.cosh(r0)
  }

  if (k >= 1) {
    return {
      center: [normalizeLongitude(toLng), to.center[1]],
      zoom: Number(Math.max(0.5, Math.min(maxZoom, z1)).toFixed(3)),
      bearing: 0,
      pitch: 0
    }
  }

  const s = k * S
  const u = travelAt(s)
  const zoom = z0 + Math.log2(scaleAt(s))
  const cx = p0x + dx * u
  const cy = p0y + dy * u
  const lng = (cx / worldSize0) * 360 - 180
  const lat = inverseMercatorY(cy / worldSize0)

  return {
    center: [normalizeLongitude(lng), lat],
    zoom: Number(Math.max(0.5, Math.min(maxZoom, zoom)).toFixed(3)),
    bearing: 0,
    pitch: 0
  }
}

export interface MoveSegmentFrameState {
  /** 當前鏡頭狀態 */
  camera: CameraState
  /** 路線延伸進度 (0 ~ 1) */
  routeProgress: number
  /** 是否顯示起點氣泡 */
  showOriginBubble: boolean
  /** 是否顯示終點氣泡與底部字幕 */
  showDestinationBubble: boolean
  /** 終點標記回彈縮放倍率 */
  destinationMarkerScale: number
}

/** 移動段各階段的時間點（秒），依據規格書 §2.4 */
const MOVE_TOTAL_SEC = 3.5
const MOVE_HOLD_END_SEC = 0.6
const MOVE_TRAVEL_END_SEC = 2.8

/**
 * 移動段的起始與結束鏡頭：
 * - 結束鏡頭框住起訖點與路線（上 22%、下 20%、左右 14% 留白），近距離時最多推近到 MAX_MOVE_FIT_ZOOM（街道層級），讓路線佔滿畫面
 * - 起始鏡頭以起點為中心；縮放取「結束鏡頭」與「城市層級 10」較近者——
 *   近距離移動時起訖鏡頭同一縮放層級，只做平移、不會先拉高再降下；長途移動則從城市層級拉遠
 */
export function computeMoveCameras(
  fromStation: Station,
  toStation: Station,
  viewport: { width: number; height: number } = DEFAULT_VIEWPORT,
  route?: [number, number][]
): { start: { center: [number, number]; zoom: number }; end: { center: [number, number]; zoom: number } } {
  // 一併框住路線本身：道路會繞路、大圓弧線會往高緯度彎，只框起訖點時路線可能跑出畫面
  const routePoints: Coordinates[] = []
  if (route && route.length > 2) {
    const step = Math.max(1, Math.floor(route.length / 48))
    for (let i = 0; i < route.length; i += step) {
      routePoints.push({ longitude: route[i][0], latitude: route[i][1] })
    }
  }
  const end = computeFitBoundsCamera(
    [fromStation.center, toStation.center, ...routePoints],
    viewport,
    MAX_MOVE_FIT_ZOOM,
    MOVE_FIT_PADDING
  )
  const start = {
    center: [fromStation.center.longitude, fromStation.center.latitude] as [number, number],
    zoom: Math.min(MAX_MOVE_FIT_ZOOM, Math.max(end.zoom, MAX_CAMERA_FIT_ZOOM))
  }
  return { start, end }
}

/**
 * 依據規格書 §2.4 計算移動段（3.5 秒）在進度 t ∈ [0, 1] 時的精確狀態：
 * - 0.0 – 0.6s：鏡頭停在起點站點，顯示起點標記與地名氣泡
 * - 0.6 – 2.8s：鏡頭以平滑縮放公式移至能同時框住起訖點的範圍，路線依 ease-in-out cubic 從 0% 延伸至 100%
 * - 2.8 – 3.5s：抵達終點，終點標記帶回彈動效彈出，顯示地名氣泡與底部字幕
 * NOTE: 近距離站點會推近到街道層級（見 computeMoveCameras），長途移動維持城市層級以上的視野
 */
export function evaluateMoveSegmentAt(
  fromStation: Station,
  toStation: Station,
  t: number,
  viewport: { width: number; height: number } = DEFAULT_VIEWPORT,
  route?: [number, number][]
): MoveSegmentFrameState {
  const clampedT = Math.max(0, Math.min(1, t))
  const sec = clampedT * MOVE_TOTAL_SEC

  const { start: startCamera, end: fitBothCamera } = computeMoveCameras(fromStation, toStation, viewport, route)

  if (sec <= MOVE_HOLD_END_SEC) {
    return {
      camera: { ...startCamera, bearing: 0, pitch: 0 },
      routeProgress: 0,
      showOriginBubble: true,
      showDestinationBubble: false,
      destinationMarkerScale: 0
    }
  }

  if (sec <= MOVE_TRAVEL_END_SEC) {
    const phaseProgress = (sec - MOVE_HOLD_END_SEC) / (MOVE_TRAVEL_END_SEC - MOVE_HOLD_END_SEC)
    const camera = interpolateCameraSmooth(
      startCamera,
      fitBothCamera,
      phaseProgress,
      MAX_MOVE_FIT_ZOOM,
      viewport
    )
    return {
      camera,
      routeProgress: easeInOutCubic(phaseProgress),
      showOriginBubble: phaseProgress < 0.35,
      showDestinationBubble: false,
      destinationMarkerScale: 0
    }
  }

  // 2.8s ~ 3.5s：抵達終點，計算回彈動效 (overshoot bounce)
  const arrivalProgress = (sec - MOVE_TRAVEL_END_SEC) / (MOVE_TOTAL_SEC - MOVE_TRAVEL_END_SEC)
  const bounceScale =
    arrivalProgress < 0.5
      ? (arrivalProgress / 0.5) * 1.25
      : 1.25 - ((arrivalProgress - 0.5) / 0.5) * 0.25

  return {
    camera: { ...fitBothCamera, bearing: 0, pitch: 0 },
    routeProgress: 1,
    showOriginBubble: false,
    showDestinationBubble: true,
    destinationMarkerScale: Number(bounceScale.toFixed(3))
  }
}

/**
 * 依據規格書 §5.2 實作通用確定性鏡頭函式 `cameraAt(segment, t, stations, viewport)`
 * @param segment 當前段落
 * @param t 段落內進度 0 ~ 1
 * @param stations 旅程中所有有效站點
 * @param viewport 畫布尺寸
 * @returns 該幀的確切鏡頭狀態
 */
export function cameraAt(
  segment: Segment,
  t: number,
  stations: Station[],
  viewport: { width: number; height: number } = DEFAULT_VIEWPORT
): CameraState {
  const clampedT = Math.max(0, Math.min(1, t))
  const stationMap = new Map(stations.map((s) => [s.id, s]))

  if (segment.type === 'OPENING_LOCATOR') {
    const firstStation = stationMap.get(segment.firstStationId) ?? stations[0]
    if (!firstStation) {
      return { center: [121.0, 23.5], zoom: 5, bearing: 0, pitch: 0 }
    }

    const overviewCam = computeFitBoundsCamera(
      stations.map((s) => s.center),
      viewport,
      MAX_CAMERA_FIT_ZOOM - 1
    )
    const targetCam = {
      center: [firstStation.center.longitude, firstStation.center.latitude] as [number, number],
      zoom: MAX_CAMERA_FIT_ZOOM
    }

    // 前 25% 停留全覽，後 75% 平滑推近至第一個站點
    if (clampedT <= 0.25) {
      return { ...overviewCam, bearing: 0, pitch: 0 }
    }
    const pushProgress = (clampedT - 0.25) / 0.75
    return interpolateCameraSmooth(overviewCam, targetCam, pushProgress, MAX_CAMERA_FIT_ZOOM, viewport)
  }

  if (segment.type === 'MOVE') {
    const fromSt = stationMap.get(segment.fromStationId) ?? stations[0]
    const toSt = stationMap.get(segment.toStationId) ?? stations[stations.length - 1]
    if (!fromSt || !toSt) {
      return { center: [121.0, 23.5], zoom: 5, bearing: 0, pitch: 0 }
    }
    return evaluateMoveSegmentAt(fromSt, toSt, clampedT, viewport, segment.route).camera
  }

  if (segment.type === 'OUTRO') {
    const lastStation = stations[stations.length - 1]
    if (!lastStation) {
      return { center: [121.0, 23.5], zoom: 5, bearing: 0, pitch: 0 }
    }
    const startCam = {
      center: [lastStation.center.longitude, lastStation.center.latitude] as [number, number],
      zoom: MAX_CAMERA_FIT_ZOOM
    }
    const overviewCam = computeFitBoundsCamera(
      stations.map((s) => s.center),
      viewport,
      MAX_CAMERA_FIT_ZOOM
    )
    // 前 65% 從最後一站拉遠至全覽，後 35% 維持全覽並模糊變暗浮現標題
    const pullProgress = Math.min(1, clampedT / 0.65)
    return interpolateCameraSmooth(startCam, overviewCam, pullProgress, MAX_CAMERA_FIT_ZOOM, viewport)
  }

  // INTRO 與 STATION 不顯示地圖，回傳預設或對應站點座標
  const fallbackCenter = stations[0]?.center ?? { latitude: 23.5, longitude: 121.0 }
  return {
    center: [fallbackCenter.longitude, fallbackCenter.latitude],
    zoom: MAX_CAMERA_FIT_ZOOM,
    bearing: 0,
    pitch: 0
  }
}
