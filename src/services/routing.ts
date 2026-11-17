import { buildSmoothGroundFallbackRoute } from '../domain/timeline-builder'
import type { Coordinates } from '../types/journey'

/** 記憶體快取：避免重複查詢相同起訖點的陸路路線 */
const osrmRouteCache = new Map<string, [number, number][]>()

function getRouteCacheKey(from: Coordinates, to: Coordinates): string {
  return `${from.latitude.toFixed(4)},${from.longitude.toFixed(4)}->${to.latitude.toFixed(4)},${to.longitude.toFixed(4)}`
}

/**
 * 依據規格書 §2.5 向 OSRM 公共服務查詢簡化後的道路折線；
 * 逾時（8 秒）或失敗時自動降級為平滑曲線，保證一定能產生。
 * NOTE: 公共 OSRM 伺服器實測回應常需 3 秒以上；降級結果不寫入快取，之後重新整理時會再試一次
 * @param from 起點座標
 * @param to 終點座標
 * @returns 折線座標陣列，以及是否為降級的平滑曲線
 */
export async function fetchGroundRouteWithFallback(
  from: Coordinates,
  to: Coordinates
): Promise<{ route: [number, number][]; isFallback: boolean }> {
  const key = getRouteCacheKey(from, to)
  const cached = osrmRouteCache.get(key)
  if (cached) return { route: cached, isFallback: false }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 8000)

  try {
    const coordsPair = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`
    const url = `https://router.project-osrm.org/route/v1/driving/${coordsPair}?overview=simplified&geometries=geojson`
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`OSRM HTTP ${response.status}`)
    }
    const data = (await response.json()) as {
      code?: string
      routes?: Array<{
        geometry?: {
          coordinates?: [number, number][]
        }
      }>
    }

    const coords = data.routes?.[0]?.geometry?.coordinates
    if (coords && coords.length >= 2) {
      osrmRouteCache.set(key, coords)
      return { route: coords, isFallback: false }
    }
  } catch {
    // 逾時或失敗時靜默降級為平滑曲線
  } finally {
    clearTimeout(timeoutId)
  }

  return { route: buildSmoothGroundFallbackRoute(from, to), isFallback: true }
}
