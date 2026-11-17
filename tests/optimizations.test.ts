import { describe, expect, it } from 'vitest'
import {
  computeFitBoundsCamera,
  computeLongitudeSpan,
  computeMoveCameras,
  evaluateMoveSegmentAt,
  interpolateCameraSmooth,
  unwrapRouteLongitudes
} from '../src/domain/camera-path'
import { clusterPhotosIntoStations } from '../src/domain/station-clustering'
import {
  buildGreatCircleRoute,
  groundRouteKey,
  locateTimelinePosition
} from '../src/domain/timeline-builder'
import { MAX_CAMERA_FIT_ZOOM, MAX_MOVE_FIT_ZOOM } from '../src/constants/video-config'
import type { Photo, Segment, Station } from '../src/types/journey'

function makePhoto(id: string, t: number, lat: number, lng: number): Photo {
  return {
    id,
    fileName: `${id}.jpg`,
    imageBlob: new Blob(['x']),
    width: 1920,
    height: 1080,
    captureTimeUtc: t,
    localDate: '2026-11-15',
    coordinates: { latitude: lat, longitude: lng },
    locationSource: 'exif',
    included: true
  }
}

describe('camera-path: van Wijk 平滑縮放運鏡', () => {
  const taipei = { center: [121.5654, 25.033] as [number, number], zoom: 10 }
  const auckland = { center: [174.7633, -36.8485] as [number, number], zoom: 3 }

  it('起點與終點鏡頭完全吻合', () => {
    const start = interpolateCameraSmooth(taipei, auckland, 0, 12)
    const end = interpolateCameraSmooth(taipei, auckland, 1, 12)
    expect(start.center[0]).toBeCloseTo(taipei.center[0], 4)
    expect(start.center[1]).toBeCloseTo(taipei.center[1], 4)
    expect(start.zoom).toBeCloseTo(taipei.zoom, 2)
    expect(end.center[0]).toBeCloseTo(auckland.center[0], 4)
    expect(end.center[1]).toBeCloseTo(auckland.center[1], 4)
    expect(end.zoom).toBeCloseTo(auckland.zoom, 2)
  })

  it('同縮放層級的長距離平移會在中途拉遠（飛行弧線），且永不超過縮放上限', () => {
    const a = { center: [121.5, 25.0] as [number, number], zoom: 6 }
    const b = { center: [139.7, 35.7] as [number, number], zoom: 6 }
    const mid = interpolateCameraSmooth(a, b, 0.5, MAX_CAMERA_FIT_ZOOM)
    expect(mid.zoom).toBeLessThan(6)
    for (let i = 0; i <= 20; i++) {
      const cam = interpolateCameraSmooth(a, b, i / 20, MAX_CAMERA_FIT_ZOOM)
      expect(cam.zoom).toBeLessThanOrEqual(MAX_CAMERA_FIT_ZOOM)
    }
  })

  it('中心點沿路徑單調前進，不會來回跳動', () => {
    let lastLng = -Infinity
    for (let i = 0; i <= 30; i++) {
      const cam = interpolateCameraSmooth(taipei, auckland, i / 30, 12)
      expect(cam.center[0]).toBeGreaterThanOrEqual(lastLng - 1e-6)
      lastLng = cam.center[0]
    }
  })

  it('跨換日線時走最短方向（紐西蘭 → 夏威夷不會繞過整個歐亞大陸）', () => {
    const nz = { center: [174.76, -36.85] as [number, number], zoom: 4 }
    const hawaii = { center: [-157.86, 21.31] as [number, number], zoom: 4 }
    for (let i = 0; i <= 20; i++) {
      const cam = interpolateCameraSmooth(nz, hawaii, i / 20, 10)
      const lng = cam.center[0]
      // 合法路徑上的經度只會落在 174.76 → 180 / -180 → -157.86 之間
      expect(lng >= 170 || lng <= -150).toBe(true)
    }
  })
})

describe('camera-path: 移動段鏡頭（近距離沉浸式視角）', () => {
  const station = (id: string, lat: number, lng: number): Station => ({
    id,
    photoIds: [],
    center: { latitude: lat, longitude: lng },
    autoName: id
  })
  const viewport = { width: 1920, height: 1080 }

  it('相距約 1 公里的站點推近到街道層級，路線至少佔畫面寬度的一半', () => {
    // 台北同一緯度往東約 1 公里
    const a = station('a', 25.033, 121.5654)
    const b = station('b', 25.033, 121.5753)
    const { start, end } = computeMoveCameras(a, b, viewport)
    expect(end.zoom).toBeGreaterThanOrEqual(15)
    expect(end.zoom).toBeLessThanOrEqual(MAX_MOVE_FIT_ZOOM)
    // 起訖鏡頭同一縮放層級：只平移，不會先拉高再降下
    expect(start.zoom).toBeCloseTo(end.zoom, 3)

    // 路線在畫面上的像素長度（Web Mercator，512px 世界瓦片）
    const worldPx = 512 * Math.pow(2, end.zoom)
    const routePx = ((b.center.longitude - a.center.longitude) / 360) * worldPx
    expect(routePx / viewport.width).toBeGreaterThan(0.5)

    for (let i = 0; i <= 20; i++) {
      const cam = evaluateMoveSegmentAt(a, b, i / 20, viewport).camera
      expect(cam.zoom).toBeGreaterThan(end.zoom - 1)
    }
  })

  it('長途移動仍從城市層級拉遠，不會推近到街道', () => {
    const taipei = station('tp', 25.033, 121.5654)
    const tokyo = station('tk', 35.6762, 139.6503)
    const { start, end } = computeMoveCameras(taipei, tokyo, viewport)
    expect(start.zoom).toBe(MAX_CAMERA_FIT_ZOOM)
    expect(end.zoom).toBeLessThan(MAX_CAMERA_FIT_ZOOM)
  })

  it('繞路的道路也會被框進畫面', () => {
    const a = station('a', 25.033, 121.5654)
    const b = station('b', 25.033, 121.5753)
    const detour: [number, number][] = [
      [121.5654, 25.033],
      [121.5654, 25.045],
      [121.5753, 25.045],
      [121.5753, 25.033]
    ]
    const withoutRoute = computeMoveCameras(a, b, viewport).end
    const withRoute = computeMoveCameras(a, b, viewport, detour).end
    expect(withRoute.zoom).toBeLessThan(withoutRoute.zoom)
    expect(withRoute.center[1]).toBeGreaterThan(25.035)
  })
})

describe('camera-path: 換日線範圍計算', () => {
  it('最小經度涵蓋區間跨越 ±180', () => {
    const span = computeLongitudeSpan([175, -175])
    expect(span.east - span.west).toBeCloseTo(10, 6)
  })

  it('框住跨換日線的兩點時，中心點落在換日線附近而不是 0 度經線', () => {
    const fit = computeFitBoundsCamera([
      { latitude: -17.7, longitude: 178.0 }, // 斐濟
      { latitude: -13.8, longitude: -171.8 } // 薩摩亞
    ])
    expect(Math.abs(Math.abs(fit.center[0]) - 180)).toBeLessThan(10)
    expect(fit.zoom).toBeGreaterThan(2)
  })

  it('大圓航線跨越換日線時經度連續，不會產生橫越地球的線段', () => {
    const route = buildGreatCircleRoute(
      { latitude: -36.85, longitude: 174.76 },
      { latitude: 21.31, longitude: -157.86 }
    )
    for (let i = 1; i < route.length; i++) {
      expect(Math.abs(route[i][0] - route[i - 1][0])).toBeLessThan(20)
    }
    const unwrapped = unwrapRouteLongitudes([
      [179, 0],
      [-179, 0]
    ])
    expect(unwrapped[1][0]).toBe(181)
  })
})

describe('station-clustering: 站點 ID 唯一性', () => {
  it('重新分站後不會重用先前的站點 ID', () => {
    const photos = [
      makePhoto('a', 1, 25.03, 121.56),
      makePhoto('b', 2, 24.99, 121.3),
      makePhoto('c', 3, 22.62, 120.3)
    ]
    const first = clusterPhotosIntoStations(photos, 10)
    const second = clusterPhotosIntoStations(photos, 50)
    const firstIds = new Set(first.stations.map((s) => s.id))
    for (const st of second.stations) {
      expect(firstIds.has(st.id)).toBe(false)
    }
  })

  it('陸路路線快取鍵以起訖座標決定，與站點 ID 無關', () => {
    const a = { latitude: 25.033, longitude: 121.5654 }
    const b = { latitude: 24.9936, longitude: 121.301 }
    expect(groundRouteKey(a, b)).toBe(groundRouteKey({ ...a }, { ...b }))
    expect(groundRouteKey(a, b)).not.toBe(groundRouteKey(b, a))
  })
})

describe('timeline-builder: 時間定位', () => {
  const timeline: Segment[] = [
    { type: 'INTRO', durationMs: 3000 },
    { type: 'OPENING_LOCATOR', durationMs: 3000, firstStationId: 's1' },
    { type: 'OUTRO', durationMs: 4000 }
  ]

  it('交界時間歸屬後一段，超出總長時停在最後一段結尾', () => {
    expect(locateTimelinePosition(timeline, 0)).toEqual({ segmentIndex: 0, segmentElapsedMs: 0 })
    expect(locateTimelinePosition(timeline, 2999)).toEqual({ segmentIndex: 0, segmentElapsedMs: 2999 })
    expect(locateTimelinePosition(timeline, 3000)).toEqual({ segmentIndex: 1, segmentElapsedMs: 0 })
    expect(locateTimelinePosition(timeline, 99999)).toEqual({ segmentIndex: 2, segmentElapsedMs: 4000 })
    expect(locateTimelinePosition([], 0)).toBeNull()
  })
})

describe('geocoding: 地名格式「區 · 城市」', async () => {
  const { formatNominatimAddress } = await import('../src/services/geocoding')

  it('台灣地址取「區」而非「里」（以實測 Nominatim 回應為樣本）', () => {
    expect(
      formatNominatimAddress({ city: '桃園市', suburb: '光興里', town: '桃園區', country: '臺灣' }).formattedName
    ).toBe('桃園區 · 桃園市')
    expect(
      formatNominatimAddress({ city: '臺北市', suburb: '信義區', neighbourhood: '西村里', village: '信義商圈', country: '臺灣', country_code: 'tw' })
        .formattedName
    ).toBe('信義區 · 臺北市')
  })

  it('只拿得到「里」時只顯示城市', () => {
    expect(formatNominatimAddress({ city: '桃園市', suburb: '光興里', country: '臺灣' }).formattedName).toBe('桃園市')
    expect(
      formatNominatimAddress({ city: '臺北市', village: '興雅', country: '臺灣', country_code: 'tw' }).formattedName
    ).toBe('臺北市')
  })

  it('海外地址取 suburb · city', () => {
    expect(
      formatNominatimAddress({ city: '奧克蘭', suburb: 'Saint Marys Bay', state: 'Auckland', country: '紐西蘭' })
        .formattedName
    ).toBe('Saint Marys Bay · 奧克蘭')
  })
})
