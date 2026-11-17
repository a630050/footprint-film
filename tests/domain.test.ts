import { describe, expect, it } from 'vitest'
import {
  formatDateRangeShort,
  formatJourneyDateRange,
  formatLocalDateDisplay,
  parseCaptureTime,
  parseTimezoneOffsetMinutes
} from '../src/domain/capture-time'
import {
  calculateDistanceKm,
  clusterPhotosIntoStations,
  computeStationCenter
} from '../src/domain/station-clustering'
import {
  buildStationDisplayCells,
  resolveDisplayCellOverlayText
} from '../src/domain/display-cells'
import {
  buildJourneyTimeline,
  calculateTotalDurationMs,
  formatDurationHuman,
  resolveRouteKind
} from '../src/domain/timeline-builder'
import {
  cameraAt,
  computeFitBoundsCamera,
  evaluateMoveSegmentAt
} from '../src/domain/camera-path'
import { generateJourneyTitle } from '../src/domain/journey-title'
import { DEFAULT_JOURNEY_SETTINGS, MAX_CAMERA_FIT_ZOOM, MAX_MOVE_FIT_ZOOM } from '../src/constants/video-config'
import type { Journey, Photo, Station } from '../src/types/journey'

/** 建立測試用照片輔助函式 */
function makeTestPhoto(overrides: Partial<Photo> & { id: string }): Photo {
  return {
    id: overrides.id,
    fileName: overrides.fileName ?? `${overrides.id}.jpg`,
    imageBlob: new Blob(['test'], { type: 'image/jpeg' }),
    width: overrides.width ?? 1920,
    height: overrides.height ?? 1080,
    captureTimeUtc: overrides.captureTimeUtc,
    localDate: overrides.localDate ?? '2026-11-15',
    coordinates: overrides.coordinates,
    locationSource: overrides.locationSource ?? (overrides.coordinates ? 'exif' : 'none'),
    included: overrides.included ?? true,
    note: overrides.note
  }
}

describe('capture-time: 拍攝時間 UTC 換算與當地日期', () => {
  it('解析時區偏移字串', () => {
    expect(parseTimezoneOffsetMinutes('+08:00')).toBe(480)
    expect(parseTimezoneOffsetMinutes('-05:00')).toBe(-300)
    expect(parseTimezoneOffsetMinutes('+13:00')).toBe(780)
    expect(parseTimezoneOffsetMinutes('Z')).toBe(0)
  })

  it('有 OffsetTimeOriginal 時將當地時間轉為正確 UTC，並保留當地日期', () => {
    // 紐西蘭夏令時間 +13:00：當地 2026-11-16 01:00:00 即 UTC 2026-11-15 12:00:00
    const nzPhoto = parseCaptureTime({
      dateTimeOriginal: '2026:11:16 01:00:00',
      offsetTimeOriginal: '+13:00'
    })
    expect(nzPhoto.localDate).toBe('2026-11-16')
    expect(nzPhoto.captureTimeUtc).toBe(Date.UTC(2026, 10, 15, 12, 0, 0))

    // 台灣 +08:00：當地 2026-11-15 18:00:00 即 UTC 2026-11-15 10:00:00
    const twPhoto = parseCaptureTime({
      dateTimeOriginal: '2026:11:15 18:00:00',
      offsetTimeOriginal: '+08:00'
    })
    expect(twPhoto.localDate).toBe('2026-11-15')
    expect(twPhoto.captureTimeUtc).toBe(Date.UTC(2026, 10, 15, 10, 0, 0))

    // 跨時區排序：台灣照片比紐西蘭照片早 2 小時拍下
    expect(twPhoto.captureTimeUtc!).toBeLessThan(nzPhoto.captureTimeUtc!)
  })

  it('無 OffsetTimeOriginal 但有 GPS 時間戳時，使用 GPS 作為 UTC 並保留 DateTimeOriginal 的當地日期', () => {
    const res = parseCaptureTime({
      dateTimeOriginal: '2026:11:16 02:30:00',
      gpsDateStamp: '2026:11:15',
      gpsTimeStamp: [13, 30, 0]
    })
    expect(res.localDate).toBe('2026-11-16')
    expect(res.captureTimeUtc).toBe(Date.UTC(2026, 10, 15, 13, 30, 0))
  })

  it('兩者皆無時，將表面當地時間視同 UTC', () => {
    const res = parseCaptureTime({
      dateTimeOriginal: '2026:11:15 09:15:00'
    })
    expect(res.localDate).toBe('2026-11-15')
    expect(res.captureTimeUtc).toBe(Date.UTC(2026, 10, 15, 9, 15, 0))
  })

  it('格式化顯示日期與範圍', () => {
    expect(formatLocalDateDisplay('2026-11-05')).toBe('2026年11月5日')
    expect(formatDateRangeShort(['2026-11-15', '2026-11-17'])).toBe('11/15 – 11/17')
    expect(formatJourneyDateRange(['2026-11-15', '2026-11-22'])).toBe('2026.11.15 – 2026.11.22')
  })
})

describe('station-clustering: 分站演算法與推定位置歸類', () => {
  const taipei = { latitude: 25.033, longitude: 121.5654 }
  const taoyuan = { latitude: 24.9936, longitude: 121.301 } // 距離台北約 27km
  const taipeiNearby = { latitude: 25.04, longitude: 121.56 } // 距離台北 < 2km

  it('支援再次造訪同地點成為不同站點（不做跨時間合併）', () => {
    const photos: Photo[] = [
      makeTestPhoto({ id: 'p1', captureTimeUtc: 1000, coordinates: taipei }),
      makeTestPhoto({ id: 'p2', captureTimeUtc: 2000, coordinates: taipeiNearby }),
      makeTestPhoto({ id: 'p3', captureTimeUtc: 3000, coordinates: taoyuan }),
      // 再次回到台北
      makeTestPhoto({ id: 'p4', captureTimeUtc: 4000, coordinates: taipei })
    ]

    const result = clusterPhotosIntoStations(photos, 10)
    expect(result.stations).toHaveLength(3)
    expect(result.stations[0].photoIds).toEqual(['p1', 'p2'])
    expect(result.stations[1].photoIds).toEqual(['p3'])
    expect(result.stations[2].photoIds).toEqual(['p4'])
  })

  it('將有拍攝時間但無定位的照片歸入推定位置，且不參與站點中心點計算', () => {
    const photos: Photo[] = [
      makeTestPhoto({ id: 'p1', captureTimeUtc: 1000, coordinates: taipei }),
      makeTestPhoto({ id: 'p2', captureTimeUtc: 2000, coordinates: taipei }),
      // 無定位，但時間 1500 在站點 1 範圍內
      makeTestPhoto({ id: 'p_inferred_inside', captureTimeUtc: 1500, coordinates: undefined, locationSource: 'none' }),
      makeTestPhoto({ id: 'p3', captureTimeUtc: 5000, coordinates: taoyuan }),
      // 無定位，時間 4500 較接近站點 2 (5000)
      makeTestPhoto({ id: 'p_inferred_near2', captureTimeUtc: 4500, coordinates: undefined, locationSource: 'none' }),
      // 無時間也無定位 → 未歸類
      makeTestPhoto({ id: 'p_unassigned', captureTimeUtc: undefined, coordinates: undefined, locationSource: 'none' })
    ]

    const result = clusterPhotosIntoStations(photos, 10)
    expect(result.stations).toHaveLength(2)
    expect(result.stations[0].photoIds).toEqual(['p1', 'p_inferred_inside', 'p2'])
    expect(result.stations[1].photoIds).toEqual(['p_inferred_near2', 'p3'])
    expect(result.photos['p_inferred_inside'].locationSource).toBe('inferred')
    expect(result.photos['p_inferred_near2'].locationSource).toBe('inferred')
    expect(result.unassignedPhotoIds).toEqual(['p_unassigned'])

    // 驗證推定位置不影響中心點計算
    const tamperedInferred: Photo = {
      ...result.photos['p_inferred_inside'],
      coordinates: { latitude: 0, longitude: 0 },
      locationSource: 'inferred'
    }
    const center = computeStationCenter([result.photos['p1'], tamperedInferred])
    expect(center.latitude).toBeCloseTo(taipei.latitude, 5)
    expect(center.longitude).toBeCloseTo(taipei.longitude, 5)
  })
})

describe('display-cells: 展示格與拼圖分組規則 (§3.2)', () => {
  it('橫式影片：連續直拍 3 張並排、2 張並排、落單 1 張單張顯示，且被橫拍隔開不跨越組合', () => {
    // 建立：4 張直拍（應拆為 3 + 1 單張）、1 張橫拍、2 張直拍（應合為 2）、1 張直拍被橫拍隔開
    const photos: Photo[] = [
      makeTestPhoto({ id: 'v1', width: 1080, height: 1920, note: '備註A' }),
      makeTestPhoto({ id: 'v2', width: 1080, height: 1920, note: '備註B' }),
      makeTestPhoto({ id: 'v3', width: 1080, height: 1920 }),
      makeTestPhoto({ id: 'v4', width: 1080, height: 1920 }), // 落單 1 張
      makeTestPhoto({ id: 'h1', width: 1920, height: 1080 }), // 橫拍隔開
      makeTestPhoto({ id: 'v5', width: 1080, height: 1920 }),
      makeTestPhoto({ id: 'v6', width: 1080, height: 1920 })
    ]

    const cells = buildStationDisplayCells(photos, {
      orientation: 'landscape',
      secondsPerCell: 2,
      autoCollage: true
    })

    expect(cells.map((c) => c.photoIds)).toEqual([
      ['v1', 'v2', 'v3'],
      ['v4'],
      ['h1'],
      ['v5', 'v6']
    ])

    // 測試 §2.3 拼圖格備註優先順序：取格內第一張有照片備註的照片
    const photosMap = Object.fromEntries(photos.map((p) => [p.id, p]))
    const overlay = resolveDisplayCellOverlayText(cells[0], photosMap, '中壢區 · 桃園市', '站點備註')
    expect(overlay.line1Title).toBe('中壢區 · 桃園市')
    expect(overlay.line2Date).toBe('2026年11月15日')
    expect(overlay.line3Note).toBe('備註A')

    // 若格內皆無照片備註則回退至站點備註
    const overlayFallback = resolveDisplayCellOverlayText(cells[3], photosMap, '中壢區 · 桃園市', '站點備註')
    expect(overlayFallback.line3Note).toBe('站點備註')
  })

  it('直式影片：連續橫拍最多 2 張上下排列', () => {
    const photos: Photo[] = [
      makeTestPhoto({ id: 'h1', width: 1920, height: 1080 }),
      makeTestPhoto({ id: 'h2', width: 1920, height: 1080 }),
      makeTestPhoto({ id: 'h3', width: 1920, height: 1080 }),
      makeTestPhoto({ id: 'v1', width: 1080, height: 1920 })
    ]

    const cells = buildStationDisplayCells(photos, {
      orientation: 'portrait',
      secondsPerCell: 2,
      autoCollage: true
    })

    expect(cells.map((c) => c.photoIds)).toEqual([
      ['h1', 'h2'],
      ['h3'],
      ['v1']
    ])
  })
})

describe('timeline-builder: 長度估算範例 (§2.6)', () => {
  it('8 個站點、60 張入選照片、每格 2 秒、未產生拼圖時總長為 154.5 秒 (154500ms)', () => {
    const photos: Record<string, Photo> = {}
    const stations: Station[] = []

    let photoIdx = 1
    for (let s = 1; s <= 8; s++) {
      const count = s <= 4 ? 8 : 7 // 4*8 + 4*7 = 60 張
      const ids: string[] = []
      for (let k = 0; k < count; k++) {
        const id = `p-${photoIdx++}`
        photos[id] = makeTestPhoto({
          id,
          width: 1920,
          height: 1080
        })
        ids.push(id)
      }
      stations.push({
        id: `st-${s}`,
        photoIds: ids,
        center: { latitude: 24 + s * 0.2, longitude: 121 },
        autoName: `站點 ${s}`
      })
    }

    const journey: Journey = {
      photos,
      stations,
      unassignedPhotoIds: [],
      title: '測試旅程',
      isTitleCustomized: false,
      hasManualStationEdits: false,
      settings: {
        ...DEFAULT_JOURNEY_SETTINGS,
        secondsPerCell: 2,
        autoCollage: false
      }
    }

    const timeline = buildJourneyTimeline(journey)
    const totalMs = calculateTotalDurationMs(timeline)
    expect(totalMs).toBe(154_500)
    expect(formatDurationHuman(totalMs)).toBe('2 分 35 秒')
  })

  it('依據長途門檻判定飛行路線或陸路路線', () => {
    const taipei = { latitude: 25.033, longitude: 121.5654 }
    const taoyuan = { latitude: 24.9936, longitude: 121.301 } // ~27km
    const kaohsiung = { latitude: 22.6273, longitude: 120.3014 } // ~300km

    expect(calculateDistanceKm(taipei, taoyuan)).toBeLessThan(100)
    expect(resolveRouteKind(taipei, taoyuan, 100)).toBe('ground')
    expect(resolveRouteKind(taipei, kaohsiung, 100)).toBe('flight')
  })
})

describe('camera-path & journey-title: 鏡頭縮放限制與旅程標題產生', () => {
  it('短距離移動時推近到街道層級，但不超過 MAX_MOVE_FIT_ZOOM', () => {
    const stA: Station = {
      id: 's1',
      photoIds: [],
      center: { latitude: 25.033, longitude: 121.5654 },
      autoName: '信義區 · 台北市'
    }
    const stB: Station = {
      id: 's2',
      photoIds: [],
      center: { latitude: 25.035, longitude: 121.567 }, // 距離僅數百公尺
      autoName: '大安區 · 台北市'
    }

    const fit = computeFitBoundsCamera([stA.center, stB.center])
    expect(fit.zoom).toBeLessThanOrEqual(MAX_CAMERA_FIT_ZOOM)

    for (const t of [0, 0.1, 0.5, 0.85, 1]) {
      const state = evaluateMoveSegmentAt(stA, stB, t)
      expect(state.camera.zoom).toBeLessThanOrEqual(MAX_MOVE_FIT_ZOOM)
      expect(state.camera.zoom).toBeGreaterThan(MAX_CAMERA_FIT_ZOOM)
      const cam = cameraAt(
        {
          type: 'MOVE',
          durationMs: 3500,
          fromStationId: 's1',
          toStationId: 's2',
          routeKind: 'ground',
          route: [
            [stA.center.longitude, stA.center.latitude],
            [stB.center.longitude, stB.center.latitude]
          ]
        },
        t,
        [stA, stB]
      )
      expect(cam.zoom).toBeLessThanOrEqual(MAX_MOVE_FIT_ZOOM)
    }
  })

  it('自動產生旅程標題', () => {
    const stations: Station[] = [
      {
        id: 's1',
        photoIds: [],
        center: { latitude: 25, longitude: 121.2 },
        autoName: '中壢區 · 桃園市',
        cityName: '桃園市',
        countryName: '台灣'
      },
      {
        id: 's2',
        photoIds: [],
        center: { latitude: -37.78, longitude: 175.28 },
        autoName: 'Hamilton East · Hamilton',
        cityName: 'Hamilton',
        countryName: '紐西蘭'
      }
    ]
    expect(generateJourneyTitle(stations)).toBe('桃園市 → Hamilton')

    const sameCityStations: Station[] = [
      { ...stations[1], id: 'a' },
      { ...stations[1], id: 'b' }
    ]
    expect(generateJourneyTitle(sameCityStations)).toBe('紐西蘭之旅')
  })
})
