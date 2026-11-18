import greatCircle from '@turf/great-circle'
import { point } from '@turf/helpers'
import {
  INTRO_DURATION_MS,
  MOVE_DURATION_MS,
  OPENING_LOCATOR_DURATION_MS,
  OUTRO_DURATION_MS
} from '../constants/video-config'
import type { Coordinates, Journey, RouteKind, Segment, Station } from '../types/journey'
import { unwrapLongitudeNear, unwrapRouteLongitudes } from './camera-path'
import { buildStationCells } from './pages'
import { calculateDistanceKm } from './station-clustering'

/**
 * 產生飛行路線（地球大圓弧線）
 * @param from 起點座標
 * @param to 終點座標
 * @param npoints 弧線取樣點數
 * @returns [lng, lat][] 陣列
 */
export function buildGreatCircleRoute(
  from: Coordinates,
  to: Coordinates,
  npoints = 64
): [number, number][] {
  if (
    Math.abs(from.latitude - to.latitude) < 1e-6 &&
    Math.abs(from.longitude - to.longitude) < 1e-6
  ) {
    return [
      [from.longitude, from.latitude],
      [to.longitude, to.latitude]
    ]
  }

  try {
    const start = point([from.longitude, from.latitude])
    const end = point([to.longitude, to.latitude])
    const arc = greatCircle(start, end, { npoints })
    const geom = arc.geometry
    // NOTE: 跨換日線時 turf 會回傳 MultiLineString，攤平後必須展開經度，否則會畫出橫越整個地球的直線
    if (geom.type === 'LineString') {
      return unwrapRouteLongitudes(geom.coordinates.map((c) => [c[0], c[1]]))
    }
    if (geom.type === 'MultiLineString') {
      return unwrapRouteLongitudes(geom.coordinates.flat().map((c) => [c[0], c[1]]))
    }
  } catch {
    // 退回直線
  }

  return [
    [from.longitude, from.latitude],
    [unwrapLongitudeNear(to.longitude, from.longitude), to.latitude]
  ]
}

/**
 * 產生二次貝茲平滑曲線（作為陸路路線預設或 OSRM 失敗降級方案）
 * @param from 起點座標
 * @param to 終點座標
 * @param segments 取樣段數
 * @returns [lng, lat][] 陣列
 */
export function buildSmoothGroundFallbackRoute(
  from: Coordinates,
  to: Coordinates,
  segments = 40
): [number, number][] {
  const toLng = unwrapLongitudeNear(to.longitude, from.longitude)
  const dx = toLng - from.longitude
  const dy = to.latitude - from.latitude
  const midLng = (from.longitude + toLng) / 2
  const midLat = (from.latitude + to.latitude) / 2

  // 垂直偏移 15% 製造自然彎曲感
  const ctrlLng = midLng - dy * 0.15
  const ctrlLat = midLat + dx * 0.15

  const pts: [number, number][] = []
  for (let i = 0; i <= segments; i++) {
    const t = i / segments
    const inv = 1 - t
    const lng = inv * inv * from.longitude + 2 * inv * t * ctrlLng + t * t * toLng
    const lat = inv * inv * from.latitude + 2 * inv * t * ctrlLat + t * t * to.latitude
    pts.push([lng, lat])
  }
  return pts
}

/**
 * 根據距離與長途門檻決定路線類型
 * - 兩站距離 > longDistanceThresholdKm → 'flight'（大圓弧線）
 * - 兩站距離 ≤ longDistanceThresholdKm → 'ground'（陸路路線）
 */
export function resolveRouteKind(
  from: Coordinates,
  to: Coordinates,
  longDistanceThresholdKm: number
): RouteKind {
  const distKm = calculateDistanceKm(from, to)
  return distKm > longDistanceThresholdKm ? 'flight' : 'ground'
}

/**
 * 兩站之間實際採用的交通方式：使用者在目的站手動指定時優先（例如 300 公里的高鐵仍是陸路），
 * 否則依長途門檻自動判斷
 */
export function resolveLegRouteKind(
  from: Pick<Station, 'center'>,
  to: Pick<Station, 'center' | 'arrivalRouteKind'>,
  longDistanceThresholdKm: number
): RouteKind {
  return to.arrivalRouteKind ?? resolveRouteKind(from.center, to.center, longDistanceThresholdKm)
}

/**
 * 陸路路線快取鍵：以起訖座標（小數 4 位，約 11 公尺）為鍵，而不是站點 ID。
 * NOTE: 重新分站、合併、加入照片後站點 ID 會改變或被重用，以 ID 為鍵會把舊路線套到不同的站點組合上
 */
export function groundRouteKey(from: Coordinates, to: Coordinates): string {
  return `${from.latitude.toFixed(4)},${from.longitude.toFixed(4)}->${to.latitude.toFixed(4)},${to.longitude.toFixed(4)}`
}

/**
 * 由旅程資料建立完整的段落時間軸（Segment[]）
 * NOTE: 只納入「至少有 1 張入選照片」的有效站點（刪除站點或全取消入選的站點不產生站點段與移動段）
 * 段落順序：
 * 片頭（3s）→ 開場定位段（3s）→ 站點段 1 →（移動段 3.5s → 站點段 k）× (N-1) → 片尾（4s）
 *
 * @param journey 旅程物件
 * @param cachedGroundRoutes 已快取的 OSRM 陸路路線字典（key: groundRouteKey(起點, 終點)）
 * @returns 段落時間軸陣列
 */
export function buildJourneyTimeline(
  journey: Journey,
  cachedGroundRoutes?: Record<string, [number, number][]>
): Segment[] {
  const activeStations = journey.stations
    .map((station) => {
      const cells = buildStationCells(station, journey.photos, journey.settings)
      return { station, cells }
    })
    .filter((item) => item.cells.length > 0)

  if (activeStations.length === 0) {
    return []
  }

  const segments: Segment[] = []

  // 1. 片頭 (3 秒)
  segments.push({
    type: 'INTRO',
    durationMs: INTRO_DURATION_MS
  })

  // 2. 開場定位段 (3 秒)
  segments.push({
    type: 'OPENING_LOCATOR',
    durationMs: OPENING_LOCATOR_DURATION_MS,
    firstStationId: activeStations[0].station.id
  })

  // 3. 各站點段與站點間的移動段
  for (let i = 0; i < activeStations.length; i++) {
    const { station, cells } = activeStations[i]

    if (i > 0) {
      const prevStation = activeStations[i - 1].station
      const routeKind = resolveLegRouteKind(prevStation, station, journey.settings.longDistanceThresholdKm)
      const cacheKey = groundRouteKey(prevStation.center, station.center)
      let route: [number, number][]

      if (routeKind === 'flight') {
        route = buildGreatCircleRoute(prevStation.center, station.center)
      } else if (cachedGroundRoutes && cachedGroundRoutes[cacheKey]?.length >= 2) {
        route = cachedGroundRoutes[cacheKey]
      } else {
        route = buildSmoothGroundFallbackRoute(prevStation.center, station.center)
      }

      segments.push({
        type: 'MOVE',
        durationMs: MOVE_DURATION_MS,
        fromStationId: prevStation.id,
        toStationId: station.id,
        routeKind,
        route
      })
    }

    const stationDurationMs = cells.reduce((sum, cell) => sum + cell.durationMs, 0)
    segments.push({
      type: 'STATION',
      durationMs: stationDurationMs,
      stationId: station.id,
      cells
    })
  }

  // 4. 片尾 (4 秒)
  segments.push({
    type: 'OUTRO',
    durationMs: OUTRO_DURATION_MS
  })

  return segments
}

/**
 * 找出全域時間點所在的段落與段落內經過時間
 * NOTE: 落在兩段交界時歸屬後一段（段落內時間 0）；超出總長時停在最後一段的結尾
 * @param timeline 段落時間軸
 * @param globalTimeMs 全域時間（毫秒）
 */
export function locateTimelinePosition(
  timeline: Segment[],
  globalTimeMs: number
): { segmentIndex: number; segmentElapsedMs: number } | null {
  if (timeline.length === 0) return null
  let accumulatedMs = 0
  for (let i = 0; i < timeline.length; i++) {
    const seg = timeline[i]
    if (globalTimeMs < accumulatedMs + seg.durationMs) {
      return { segmentIndex: i, segmentElapsedMs: Math.max(0, globalTimeMs - accumulatedMs) }
    }
    accumulatedMs += seg.durationMs
  }
  const lastIndex = timeline.length - 1
  return { segmentIndex: lastIndex, segmentElapsedMs: timeline[lastIndex].durationMs }
}

/**
 * 計算時間軸總長度（毫秒）
 * @param segments 段落時間軸陣列
 */
export function calculateTotalDurationMs(segments: Segment[]): number {
  return segments.reduce((sum, seg) => sum + seg.durationMs, 0)
}

/**
 * 將毫秒數格式化為人類易讀的時間長度（如 '2 分 35 秒' 或 '42 秒'）
 * @param durationMs 總毫秒數
 */
export function formatDurationHuman(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000)
  if (totalSeconds <= 0) return '0 秒'
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds} 秒`
  if (seconds === 0) return `${minutes} 分`
  return `${minutes} 分 ${seconds} 秒`
}
