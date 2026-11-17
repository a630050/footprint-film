import { NOMINATIM_MIN_INTERVAL_MS } from '../constants/video-config'
import type { Coordinates } from '../types/journey'

export interface ReverseGeocodeResult {
  /** 依據 §4.4 格式化後的站點名稱，如 '中壢區 · 桃園市' 或 'Hamilton East · Hamilton' */
  formattedName: string
  /** 城市名稱（用於自動產生旅程標題） */
  cityName?: string
  /** 國家名稱（用於自動產生旅程標題） */
  countryName?: string
  /** 查詢失敗（網路錯誤或被限流）；呼叫端應保留暫定名稱，之後再重試 */
  failed?: boolean
}

export interface PlaceSearchResult {
  displayName: string
  shortName: string
  coordinates: Coordinates
}

/** 座標快取（四捨五入到小數點後 3 位，約 110 公尺精度） */
const reverseCache = new Map<string, ReverseGeocodeResult>()

let lastRequestTimeMs = 0
let rateLimitQueue: Promise<void> = Promise.resolve()

/**
 * 節流等待：確保兩次 Nominatim 請求間隔 ≥ 1.1 秒（遵守 OSM Nominatim 合理使用規範）
 * NOTE: 以 Promise 佇列串接，多個呼叫端同時等待時也會依序排隊，不會在同一瞬間一起送出
 */
function waitForNominatimRateLimit(): Promise<void> {
  const turn = rateLimitQueue.then(async () => {
    const elapsed = Date.now() - lastRequestTimeMs
    if (elapsed < NOMINATIM_MIN_INTERVAL_MS) {
      await new Promise((resolve) => setTimeout(resolve, NOMINATIM_MIN_INTERVAL_MS - elapsed))
    }
    lastRequestTimeMs = Date.now()
  })
  rateLimitQueue = turn.catch(() => undefined)
  return turn
}

/** 是否已有此座標的地名快取（用於判斷是否需要顯示查詢進度） */
export function hasCachedReverseGeocode(coords: Coordinates): boolean {
  return reverseCache.has(getCoordCacheKey(coords))
}

function getCoordCacheKey(coords: Coordinates): string {
  return `${coords.latitude.toFixed(3)},${coords.longitude.toFixed(3)}`
}

/**
 * 從 Nominatim 地址中挑出「區／鄉鎮」層級的名稱
 * NOTE: 台灣的「里／村」屬於比「區」更細的層級，分站半徑 10km 時一站常跨好幾個里，不適合當站點名稱
 */
function pickDistrictName(address: Record<string, string | undefined>): string | undefined {
  const isTooFineLevel = (name?: string) => Boolean(name && /[里村]$/.test(name))
  // 台灣的 village 欄位是「里」（名稱常不含「里」字，如「興雅」）或商圈，一律不當作區
  const isTaiwan = address.country_code === 'tw'
  return [
    address.city_district,
    address.borough,
    address.town,
    address.suburb,
    address.municipality,
    isTaiwan ? undefined : address.village
  ].find((name) => name && !isTooFineLevel(name))
}

/**
 * 依據規格書 §4.4 將 Nominatim address 欄位格式化為 `區（或鄉鎮）· 城市`
 * 取不到區則只顯示城市；城市也取不到則顯示國家
 */
export function formatNominatimAddress(
  address?: Record<string, string | undefined>,
  fallbackLabel = '未知地點'
): ReverseGeocodeResult {
  if (!address) {
    return { formattedName: fallbackLabel }
  }

  const district = pickDistrictName(address)

  const city =
    address.city ||
    address.county ||
    address.state_district ||
    address.state ||
    address.province ||
    address.region

  const country = address.country

  if (district && city && district !== city) {
    return {
      formattedName: `${district} · ${city}`,
      cityName: city,
      countryName: country
    }
  }

  if (city) {
    return {
      formattedName: city,
      cityName: city,
      countryName: country
    }
  }

  if (district) {
    return {
      formattedName: district,
      cityName: district,
      countryName: country
    }
  }

  if (country) {
    return {
      formattedName: country,
      countryName: country
    }
  }

  return { formattedName: fallbackLabel }
}

/**
 * 反向地理編碼：由站點中心座標查詢地名
 * 語言優先順序：zh-TW → zh → en → 當地語言
 * @param coords 站點中心座標
 * @param isCancelled 排隊等待後檢查是否已不需要此結果
 * @returns 格式化後的地名資訊
 */
export async function reverseGeocodeStationCenter(
  coords: Coordinates,
  isCancelled?: () => boolean
): Promise<ReverseGeocodeResult> {
  const cacheKey = getCoordCacheKey(coords)
  const cached = reverseCache.get(cacheKey)
  if (cached) {
    return cached
  }

  const fallbackCoordLabel = `${coords.latitude.toFixed(2)}, ${coords.longitude.toFixed(2)}`

  const detailed = await fetchReverseAddress(coords, 14, isCancelled)
  if (!detailed) {
    return { formattedName: fallbackCoordLabel, failed: true }
  }

  let address = detailed.address
  // NOTE: 台灣在 zoom 14 常只回傳「里」或商圈名稱，拿不到「區」；此時再查一次 zoom 12（區／鄉鎮層級）。
  // 其他國家 zoom 12 反而會回傳過粗或行政用的名稱（如奧克蘭變成「Waitematā」），因此只對台灣補查
  if (address?.country_code === 'tw' && !pickDistrictName(address)) {
    const coarse = await fetchReverseAddress(coords, 12, isCancelled)
    if (coarse?.address) {
      address = { ...address, ...coarse.address }
    }
  }

  const result = formatNominatimAddress(address, detailed.name || fallbackCoordLabel)
  reverseCache.set(cacheKey, result)
  return result
}

/**
 * 發出一次 Nominatim 反向查詢（含節流排隊）
 * @returns 地址欄位；網路錯誤、被限流或呼叫端已取消時回傳 null
 */
async function fetchReverseAddress(
  coords: Coordinates,
  zoom: number,
  isCancelled?: () => boolean
): Promise<{ address?: Record<string, string | undefined>; name?: string } | null> {
  await waitForNominatimRateLimit()
  // 排隊期間若呼叫端已放棄（例如使用者又重新分站），就不再送出請求
  if (isCancelled?.()) return null

  const url = new URL('https://nominatim.openstreetmap.org/reverse')
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('lat', String(coords.latitude))
  url.searchParams.set('lon', String(coords.longitude))
  url.searchParams.set('zoom', String(zoom))
  url.searchParams.set('addressdetails', '1')
  // zh-Hant 對應 OSM 的 name:zh-Hant 標籤；只寫 zh-TW 時海外地名常退回簡體（如「奥克兰」）
  url.searchParams.set('accept-language', 'zh-Hant,zh-TW;q=0.9,zh;q=0.8,en;q=0.7')

  try {
    const response = await fetch(url.toString(), { headers: { Accept: 'application/json' } })
    if (!response.ok) return null
    return (await response.json()) as { address?: Record<string, string | undefined>; name?: string }
  } catch {
    return null
  }
}

/**
 * 正向地名搜尋（用於「手動建立站點」）
 * @param query 使用者輸入的地名關鍵字
 */
export async function searchPlaceByName(query: string): Promise<PlaceSearchResult[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  await waitForNominatimRateLimit()

  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('q', trimmed)
  url.searchParams.set('limit', '5')
  url.searchParams.set('addressdetails', '1')
  url.searchParams.set('accept-language', 'zh-Hant,zh-TW;q=0.9,zh;q=0.8,en;q=0.7')

  try {
    const response = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json'
      }
    })
    if (!response.ok) return []

    const list = (await response.json()) as Array<{
      display_name: string
      name?: string
      lat: string
      lon: string
      address?: Record<string, string | undefined>
    }>

    return list.map((item) => {
      const formatted = formatNominatimAddress(
        item.address,
        item.name || item.display_name.split(',')[0]
      )
      return {
        displayName: item.display_name,
        shortName: formatted.formattedName,
        coordinates: {
          latitude: Number(item.lat),
          longitude: Number(item.lon)
        }
      }
    })
  } catch {
    return []
  }
}
