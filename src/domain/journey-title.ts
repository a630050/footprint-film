import type { Station } from '../types/journey'

/**
 * 從站點格式化名稱（如 '中壢區 · 桃園市' 或 'Hamilton East · Hamilton'）擷取城市或主要地名
 * @param station 站點物件
 */
export function extractStationShortPlaceName(station: Station): string {
  if (station.customName && station.customName.trim().length > 0) {
    return station.customName.trim()
  }
  if (station.cityName && station.cityName.trim().length > 0) {
    return station.cityName.trim()
  }
  const raw = station.autoName.trim()
  if (raw.includes('·')) {
    const parts = raw
      .split('·')
      .map((s) => s.trim())
      .filter(Boolean)
    return parts[parts.length - 1] || raw
  }
  return raw
}

/**
 * 依據規格書 §4.3 自動產生旅程標題
 * - 預設依第一站與最後一站的城市或國家自動產生（如「桃園市 → 漢米頓」或「紐西蘭之旅」）
 * - 若只有一個站點，則產生「[地名]之旅」
 * - 若首尾站點屬於不同城市，產生「[第一站城市] → [最後一站城市]」
 * - 若首尾站點地名相同且有國家名稱，產生「[國家]之旅」；否則「[城市]之旅」
 *
 * @param stations 依時間排列的站點清單
 * @returns 自動產生的旅程標題
 */
export function generateJourneyTitle(stations: Station[]): string {
  if (stations.length === 0) {
    return '我的旅遊回憶'
  }

  const first = stations[0]
  const last = stations[stations.length - 1]

  const firstPlace = extractStationShortPlaceName(first)
  const lastPlace = extractStationShortPlaceName(last)

  if (stations.length === 1) {
    return `${firstPlace}之旅`
  }

  if (firstPlace && lastPlace && firstPlace !== lastPlace) {
    return `${firstPlace} → ${lastPlace}`
  }

  // 若首尾城市相同（例如環島或同城多站），檢查是否全在同一個國家
  const countries = Array.from(
    new Set(stations.map((s) => s.countryName?.trim()).filter(Boolean))
  )
  if (countries.length === 1 && countries[0]) {
    return `${countries[0]}之旅`
  }

  return `${firstPlace || '美好'}之旅`
}
