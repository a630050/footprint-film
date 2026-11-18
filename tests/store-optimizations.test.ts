import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { isDuplicatePhoto } from '../src/services/photo-reader'
import { useJourneyStore } from '../src/store/journey-store'
import type { Photo } from '../src/types/journey'

function makePhoto(overrides: Partial<Photo> & { id: string }): Photo {
  return {
    id: overrides.id,
    fileName: overrides.fileName ?? `${overrides.id}.jpg`,
    imageBlob: new Blob(['test'], { type: 'image/jpeg' }),
    width: overrides.width ?? 1920,
    height: overrides.height ?? 1080,
    captureTimeUtc: overrides.captureTimeUtc,
    localDate: overrides.localDate ?? '2026-11-15',
    coordinates: overrides.coordinates ?? { latitude: 25.033, longitude: 121.5654 },
    locationSource: overrides.locationSource ?? 'exif',
    included: overrides.included ?? true,
    note: overrides.note
  }
}

/**
 * store 的操作會在背景查詢地名（Nominatim）與陸路路線（OSRM）。
 * 測試不可連到真實的公開服務（違反使用規範、結果也會受網路影響），因此以假的 fetch 攔截並一律回傳失敗，
 * 讓背景查詢走既有的失敗處理（保留暫定名稱、改用平滑曲線路線）。
 */
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  throw new Error(`測試中禁止網路請求：${String(input)}`)
})

beforeAll(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('journey-store 優化驗證', () => {
  beforeEach(async () => {
    await useJourneyStore.getState().discardPendingDraftAndReset()
  })

  it('封面照片被取消入選或刪除站點時會自動遞補；手動將未入選照片設為封面會勾回入選', () => {
    const store = useJourneyStore.getState()
    const p1 = makePhoto({ id: 'p1', captureTimeUtc: 1000, coordinates: { latitude: 25.033, longitude: 121.5654 } })
    const p2 = makePhoto({ id: 'p2', captureTimeUtc: 2000, coordinates: { latitude: 25.034, longitude: 121.566 } })
    const p3 = makePhoto({ id: 'p3', captureTimeUtc: 3000, coordinates: { latitude: 22.627, longitude: 120.301 } })
    store.appendUploadedPhotos([p1, p2, p3])

    expect(useJourneyStore.getState().journey.coverPhotoId).toBe('p1')

    // 取消目前封面的入選 → 自動遞補為 p2
    useJourneyStore.getState().togglePhotoIncluded('p1')
    expect(useJourneyStore.getState().journey.coverPhotoId).toBe('p2')

    // 刪除第一站（該站全體取消入選）→ 自動遞補為第二站的 p3
    const firstStationId = useJourneyStore.getState().journey.stations[0].id
    useJourneyStore.getState().deleteStation(firstStationId)
    expect(useJourneyStore.getState().journey.coverPhotoId).toBe('p3')

    // 手動將未入選的 p1 設為封面 → p1 自動重新入選
    useJourneyStore.getState().setCoverPhoto('p1')
    const afterSet = useJourneyStore.getState().journey
    expect(afterSet.coverPhotoId).toBe('p1')
    expect(afterSet.photos.p1.included).toBe(true)
  })

  it('splitStationAtPhoto 會依拆分後照片清理多餘分頁與失效的多圖樣式', () => {
    const store = useJourneyStore.getState()
    const p1 = makePhoto({ id: 'p1', captureTimeUtc: 1000 })
    const p2 = makePhoto({ id: 'p2', captureTimeUtc: 2000 })
    const p3 = makePhoto({ id: 'p3', captureTimeUtc: 3000 })
    store.appendUploadedPhotos([p1, p2, p3])

    const stationId = useJourneyStore.getState().journey.stations[0].id
    // 先手動把三張設為同一頁「左右並排」
    useJourneyStore.getState().updateStationPages(stationId, [
      { id: 'page-1', photoIds: ['p1', 'p2', 'p3'], layout: 'columns' }
    ])

    // 從 p2 拆分成兩站
    useJourneyStore.getState().splitStationAtPhoto(stationId, 'p2')
    const stations = useJourneyStore.getState().journey.stations
    expect(stations).toHaveLength(2)

    // 第一站只剩 p1 一張，不應保留 columns 樣式或跨站殘留 ID
    expect(stations[0].photoIds).toEqual(['p1'])
    expect(stations[0].pages).toEqual([{ id: 'page-1', photoIds: ['p1'], layout: undefined }])

    // 第二站只剩 p2、p3，不應包含 p1
    expect(stations[1].photoIds).toEqual(['p2', 'p3'])
    expect(stations[1].pages).toEqual([{ id: 'page-1', photoIds: ['p2', 'p3'], layout: 'columns' }])
  })

  it('resetStationPages 可重置手動分頁並支援復原與重做', () => {
    const store = useJourneyStore.getState()
    const p1 = makePhoto({ id: 'p1', captureTimeUtc: 1000 })
    const p2 = makePhoto({ id: 'p2', captureTimeUtc: 2000 })
    store.appendUploadedPhotos([p1, p2])

    const stationId = useJourneyStore.getState().journey.stations[0].id
    useJourneyStore.getState().updateStationPages(stationId, [
      { id: 'custom-1', photoIds: ['p1'], layout: 'single' },
      { id: 'custom-2', photoIds: ['p2'], layout: 'single' }
    ])
    expect(useJourneyStore.getState().journey.stations[0].pages).toHaveLength(2)

    useJourneyStore.getState().resetStationPages(stationId)
    expect(useJourneyStore.getState().journey.stations[0].pages).toBeUndefined()

    // 復原應回到手動分頁狀態
    useJourneyStore.getState().undo()
    expect(useJourneyStore.getState().journey.stations[0].pages).toHaveLength(2)

    // 重做應再次清除手動分頁
    useJourneyStore.getState().redo()
    expect(useJourneyStore.getState().journey.stations[0].pages).toBeUndefined()
  })

  it('isDuplicatePhoto 能正確識別重複照片', () => {
    expect(
      isDuplicatePhoto(
        { fileName: 'IMG_001.jpg', captureTimeUtc: 1000, width: 1920, height: 1080 },
        { fileName: 'IMG_001.jpg', captureTimeUtc: 1000, width: 1920, height: 1080 }
      )
    ).toBe(true)

    expect(
      isDuplicatePhoto(
        { fileName: 'IMG_001.jpg', captureTimeUtc: 1000, width: 1920, height: 1080 },
        { fileName: 'IMG_001.jpg', captureTimeUtc: 2000, width: 1920, height: 1080 }
      )
    ).toBe(false)

    expect(
      isDuplicatePhoto(
        { fileName: 'scan.png', captureTimeUtc: undefined, width: 1200, height: 800 },
        { fileName: 'scan.png', captureTimeUtc: undefined, width: 1200, height: 800 }
      )
    ).toBe(true)

    expect(
      isDuplicatePhoto(
        { fileName: 'scan.png', captureTimeUtc: undefined, width: 1200, height: 800 },
        { fileName: 'scan.png', captureTimeUtc: undefined, width: 800, height: 1200 }
      )
    ).toBe(false)
  })
})
