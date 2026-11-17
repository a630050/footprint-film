import distance from '@turf/distance'
import { point } from '@turf/helpers'
import type { Coordinates, Photo, Station } from '../types/journey'

/**
 * 計算兩個地理座標間的 Haversine 距離（公里）
 * @param a 座標 A
 * @param b 座標 B
 * @returns 距離（公里）
 */
export function calculateDistanceKm(a: Coordinates, b: Coordinates): number {
  const ptA = point([a.longitude, a.latitude])
  const ptB = point([b.longitude, b.latitude])
  return distance(ptA, ptB, { units: 'kilometers' })
}

/**
 * 僅由具備真實定位（exif 或 manual）的照片計算站點中心點（平均座標）
 * NOTE: 依據 §4.1 與 §7.3，推定位置（inferred）不參與站點中心點計算
 * @param photos 站點內的照片清單
 * @param fallbackCenter 當站點內無真實定位照片時的備用座標
 * @returns 站點中心點座標
 */
export function computeStationCenter(
  photos: Photo[],
  fallbackCenter: Coordinates = { latitude: 0, longitude: 0 }
): Coordinates {
  const geoPhotos = photos.filter(
    (p) =>
      p.coordinates !== undefined &&
      (p.locationSource === 'exif' || p.locationSource === 'manual')
  )

  if (geoPhotos.length === 0) {
    return fallbackCenter
  }

  const sum = geoPhotos.reduce(
    (acc, p) => ({
      latitude: acc.latitude + p.coordinates!.latitude,
      longitude: acc.longitude + p.coordinates!.longitude
    }),
    { latitude: 0, longitude: 0 }
  )

  return {
    latitude: sum.latitude / geoPhotos.length,
    longitude: sum.longitude / geoPhotos.length
  }
}

let stationIdCounter = 0

/**
 * 產生全域唯一的站點 ID。
 * NOTE: 不可用 `station-1`、`station-2` 這類依序號命名的 ID——重新分站後 ID 會被重用，
 * 進行中的地名查詢結果、路線快取就會被套到不同的站點上
 */
export function createStationId(): string {
  stationIdCounter += 1
  return `st-${Date.now().toString(36)}-${stationIdCounter.toString(36)}`
}

/** 站點尚未取得地名時的暫定名稱格式（如「站點 3」） */
export const PLACEHOLDER_STATION_NAME_PATTERN = /^站點\s*\d+$/

export interface ClusteringResult {
  /** 依時間順序排列的站點清單 */
  stations: Station[]
  /** 更新了 locationSource / coordinates 的照片字典 */
  photos: Record<string, Photo>
  /** 無定位也無拍攝時間的未歸類照片 ID 清單 */
  unassignedPhotoIds: string[]
}

/**
 * 依據規格書 §4.1 與 §4.2 進行自動分站與推定位置歸類
 * 1. 有定位（exif / manual）的照片依拍攝時間升序排列
 * 2. 依序檢查每張照片與「目前站點中心點」的 Haversine 距離 d：
 *    - d ≤ stationRadiusKm → 歸入目前站點，並更新中心點為該站有定位照片的平均座標
 *    - d > stationRadiusKm → 建立新站點
 * 3. 同一地點在不同時間再次造訪會成為不同站點（不做跨時間合併）
 * 4. 有拍攝時間但無定位的照片：
 *    - 時間落在某站點時間範圍內 → 歸入該站
 *    - 落在兩站之間 → 歸入時間較近者
 *    - 標記為 inferred（推定位置），不參與站點中心點計算
 * 5. 無定位也無拍攝時間的照片 → 放入 unassignedPhotoIds
 *
 * @param inputPhotos 輸入的照片陣列或字典
 * @param stationRadiusKm 分站半徑（公里）
 * @returns 分站結果（站點、更新後的照片字典、未歸類照片 ID）
 */
export function clusterPhotosIntoStations(
  inputPhotos: Photo[] | Record<string, Photo>,
  stationRadiusKm: number
): ClusteringResult {
  const photoList = Array.isArray(inputPhotos)
    ? inputPhotos.map((p) => ({ ...p }))
    : Object.values(inputPhotos).map((p) => ({ ...p }))

  const photosMap: Record<string, Photo> = {}
  for (const p of photoList) {
    photosMap[p.id] = p
  }

  // 分離：1. 有真實座標的照片、2. 無真實座標但有拍攝時間的照片、3. 兩者皆無的照片
  const geoPhotos: Photo[] = []
  const timeOnlyPhotos: Photo[] = []
  const unassignedPhotoIds: string[] = []

  for (const photo of photoList) {
    const hasValidGeo =
      photo.coordinates !== undefined &&
      (photo.locationSource === 'exif' || photo.locationSource === 'manual')

    if (hasValidGeo) {
      geoPhotos.push(photo)
    } else if (photo.captureTimeUtc !== undefined) {
      // 重置為推定位置候選
      photo.locationSource = 'inferred'
      photo.coordinates = undefined
      timeOnlyPhotos.push(photo)
    } else {
      photo.locationSource = 'none'
      photo.coordinates = undefined
      unassignedPhotoIds.push(photo.id)
    }
  }

  // 有定位的照片依拍攝時間升序排列（若無拍攝時間則排在最後並維持原順序）
  geoPhotos.sort((a, b) => {
    const tA = a.captureTimeUtc ?? Number.MAX_SAFE_INTEGER
    const tB = b.captureTimeUtc ?? Number.MAX_SAFE_INTEGER
    if (tA !== tB) return tA - tB
    return a.fileName.localeCompare(b.fileName)
  })

  interface TempStation {
    id: string
    geoPhotos: Photo[]
    allPhotoIds: string[]
    center: Coordinates
    minTimeUtc: number
    maxTimeUtc: number
  }

  const tempStations: TempStation[] = []

  for (const photo of geoPhotos) {
    const coords = photo.coordinates!
    const timeUtc = photo.captureTimeUtc ?? 0

    if (tempStations.length === 0) {
      tempStations.push({
        id: createStationId(),
        geoPhotos: [photo],
        allPhotoIds: [photo.id],
        center: { ...coords },
        minTimeUtc: timeUtc,
        maxTimeUtc: timeUtc
      })
      continue
    }

    const currentStation = tempStations[tempStations.length - 1]
    const distKm = calculateDistanceKm(currentStation.center, coords)

    if (distKm <= stationRadiusKm) {
      currentStation.geoPhotos.push(photo)
      currentStation.allPhotoIds.push(photo.id)
      currentStation.center = computeStationCenter(currentStation.geoPhotos, currentStation.center)
      if (photo.captureTimeUtc !== undefined) {
        currentStation.minTimeUtc = Math.min(currentStation.minTimeUtc, photo.captureTimeUtc)
        currentStation.maxTimeUtc = Math.max(currentStation.maxTimeUtc, photo.captureTimeUtc)
      }
    } else {
      tempStations.push({
        id: createStationId(),
        geoPhotos: [photo],
        allPhotoIds: [photo.id],
        center: { ...coords },
        minTimeUtc: timeUtc,
        maxTimeUtc: timeUtc
      })
    }
  }

  // 步驟 4：將有拍攝時間但無定位的照片歸入對應站點
  if (tempStations.length > 0) {
    for (const photo of timeOnlyPhotos) {
      const t = photo.captureTimeUtc!
      let targetStation = tempStations[0]
      let minTimeDiff = Infinity

      for (const st of tempStations) {
        if (t >= st.minTimeUtc && t <= st.maxTimeUtc) {
          targetStation = st
          minTimeDiff = 0
          break
        }
        const diff = t < st.minTimeUtc ? st.minTimeUtc - t : t - st.maxTimeUtc
        if (diff < minTimeDiff) {
          minTimeDiff = diff
          targetStation = st
        }
      }

      photo.locationSource = 'inferred'
      photo.coordinates = { ...targetStation.center }
      targetStation.allPhotoIds.push(photo.id)
    }
  } else {
    // 若整批照片完全沒有任何一張帶座標，有時間但無定位的照片也無法推定到任何站點，先放入未歸類區等待使用者建立站點
    for (const photo of timeOnlyPhotos) {
      photo.locationSource = 'none'
      unassignedPhotoIds.push(photo.id)
    }
  }

  // 站點內照片依拍攝時間升序排列
  const stations: Station[] = tempStations.map((st, idx) => {
    const sortedIds = [...st.allPhotoIds].sort((idA, idB) => {
      const pA = photosMap[idA]
      const pB = photosMap[idB]
      const tA = pA?.captureTimeUtc ?? Number.MAX_SAFE_INTEGER
      const tB = pB?.captureTimeUtc ?? Number.MAX_SAFE_INTEGER
      if (tA !== tB) return tA - tB
      return (pA?.fileName ?? '').localeCompare(pB?.fileName ?? '')
    })

    return {
      id: st.id,
      photoIds: sortedIds,
      center: st.center,
      autoName: `站點 ${idx + 1}`
    }
  })

  return {
    stations,
    photos: photosMap,
    unassignedPhotoIds
  }
}
