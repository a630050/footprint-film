import { create } from 'zustand'
import { DEFAULT_JOURNEY_SETTINGS } from '../constants/video-config'
import { generateJourneyTitle } from '../domain/journey-title'
import {
  clusterPhotosIntoStations,
  computeStationCenter,
  createStationId,
  PLACEHOLDER_STATION_NAME_PATTERN
} from '../domain/station-clustering'
import { groundRouteKey, resolveRouteKind } from '../domain/timeline-builder'
import {
  clearJourneyDraft,
  loadJourneyDraft,
  saveJourneyDraft
} from '../services/draft-storage'
import { hasCachedReverseGeocode, reverseGeocodeStationCenter } from '../services/geocoding'
import { fetchGroundRouteWithFallback } from '../services/routing'
import { resolveStationPages } from '../domain/pages'
import {
  createEmptyHistory,
  type JourneyHistory,
  recordHistory,
  redoHistory,
  undoHistory
} from './history'
import type {
  Coordinates,
  Journey,
  JourneySettings,
  Photo,
  Station,
  StationPage
} from '../types/journey'

/** 刪除照片時留下的復原資訊 */
export interface DeletedPhotoUndo {
  photo: Photo
  stationId?: string
  indexInStation: number
  stationPagesBefore?: StationPage[]
  unassignedIndex: number
  wasCover: boolean
}

export type AppStep = 1 | 2 | 3

export interface GeocodingProgress {
  isQuerying: boolean
  completed: number
  total: number
}

interface JourneyStoreState {
  /** 目前步驟：1=選照片, 2=編輯旅程, 3=預覽與輸出 */
  currentStep: AppStep
  /** 旅程核心資料 */
  journey: Journey
  /** 已查詢並快取的 OSRM 陸路路線字典（key: groundRouteKey(起點座標, 終點座標)） */
  groundRoutes: Record<string, [number, number][]>
  /** 地名查詢進度 */
  geocodingProgress: GeocodingProgress
  /** 進入網站時偵測到的未完成草稿（詢問使用者是否繼續） */
  pendingDraft: Journey | null
  /** 是否已完成初始草稿檢查 */
  draftChecked: boolean
  /** 最近一次刪除的照片（提供「復原」） */
  lastDeletedPhoto: DeletedPhotoUndo | null
  /** 編輯紀錄（Ctrl+Z 復原、Ctrl+Shift+Z 重做） */
  history: JourneyHistory
  /** 最近一次復原／重做的提示 */
  historyNotice: { kind: 'undo' | 'redo'; at: number } | null
  /** 復原上一步編輯 */
  undo: () => void
  /** 重做剛才復原的編輯 */
  redo: () => void

  // 步驟與草稿管理
  setCurrentStep: (step: AppStep) => void
  checkInitialDraft: () => Promise<void>
  resumePendingDraft: () => void
  discardPendingDraftAndReset: () => Promise<void>

  // 步驟①：載入照片
  appendUploadedPhotos: (newPhotos: Photo[]) => void

  // 步驟②：站點與照片編輯
  renameStation: (stationId: string, customName: string) => void
  updateStationNote: (stationId: string, note: string) => void
  mergeWithNextStation: (stationId: string) => void
  splitStationAtPhoto: (stationId: string, splitFromPhotoId: string) => void
  deleteStation: (stationId: string) => void
  togglePhotoIncluded: (photoId: string) => void
  updatePhotoNote: (photoId: string, note: string) => void
  /** 從旅程中刪除照片（可在提示列按「復原」） */
  deletePhoto: (photoId: string) => void
  undoDeletePhoto: () => void
  dismissDeletedPhoto: () => void
  /** 儲存站點的手動分頁（拖曳排序、分隔線、樣式與運鏡設定） */
  updateStationPages: (stationId: string, pages: StationPage[]) => void
  /** 清除指定站點的手動分頁，恢復依自動拼圖與連拍門檻分頁 */
  resetStationPages: (stationId: string) => void
  setCoverPhoto: (photoId: string) => void
  reorderPhotoInStation: (stationId: string, fromIndex: number, toIndex: number) => void
  movePhotoToStation: (photoId: string, targetStationId: string) => void
  createManualStationWithPhotos: (
    name: string,
    coords: Coordinates,
    photoIds: string[]
  ) => void
  assignManualLocationToPhotos: (photoIds: string[], coords: Coordinates, placeName?: string) => void

  // 設定與重新分站
  updateJourneyTitle: (title: string) => void
  updateSettings: (partial: Partial<JourneySettings>) => void
  /** 設定（或清除）移動標記用的圓形大頭照；設定時一併把移動標記切換為大頭照 */
  setTravelerAvatar: (avatar: Blob | undefined) => void
  /** 設定（或移除）使用者上傳的配樂；設定時一併切換為「自訂配樂」 */
  setCustomMusic: (music: { blob: Blob; fileName: string } | undefined) => void
  reclusterWithRadius: (newRadiusKm: number) => void

  // 非同步背景任務：查詢站點地名與陸路路線
  refreshStationNamesAndRoutes: () => Promise<void>
}

function createEmptyJourney(): Journey {
  return {
    photos: {},
    stations: [],
    unassignedPhotoIds: [],
    title: '我的旅遊回憶',
    isTitleCustomized: false,
    coverPhotoId: undefined,
    hasManualStationEdits: false,
    settings: { ...DEFAULT_JOURNEY_SETTINGS }
  }
}

/**
 * 決定預設封面照片 ID（若原封面仍為入選照片則保留，否則取第一站第一張入選照片）
 */
function pickDefaultCoverPhotoId(
  photos: Record<string, Photo>,
  stations: Station[],
  currentCoverId?: string
): string | undefined {
  if (currentCoverId && photos[currentCoverId]?.included) {
    return currentCoverId
  }
  for (const st of stations) {
    for (const id of st.photoIds) {
      if (photos[id]?.included) return id
    }
  }
  return Object.keys(photos)[0]
}

/**
 * 計算站點最早拍攝時間（用於維持站點永遠依時間排列）
 */
function getStationEarliestTime(station: Station, photos: Record<string, Photo>): number {
  let min = Number.MAX_SAFE_INTEGER
  for (const id of station.photoIds) {
    const t = photos[id]?.captureTimeUtc
    if (t !== undefined && t < min) {
      min = t
    }
  }
  return min
}

function isSameCoordinates(a: Coordinates, b: Coordinates): boolean {
  return Math.abs(a.latitude - b.latitude) < 1e-9 && Math.abs(a.longitude - b.longitude) < 1e-9
}

/**
 * 背景查詢的世代編號：每次重新觸發查詢都會遞增，舊世代的查詢迴圈看到編號改變就停止，
 * 避免使用者快速調整設定時，舊結果寫進新的站點、或同時跑多個查詢迴圈
 */
let refreshGeneration = 0

type StoreSet = (partial: Partial<JourneyStoreState>) => void
type AnyAction = (...args: never[]) => unknown

/**
 * 會改動旅程內容的使用者操作：執行前先記下旅程，供 Ctrl+Z 復原。
 * 值是「可合併的編輯種類」：同一欄位連續打字只算一步；null 表示每次都是獨立的一步。
 * 背景查詢地名、路線等自動更新不在此列，不會被記成一步
 */
const HISTORY_ACTIONS: Partial<Record<keyof JourneyStoreState, ((...args: never[]) => string) | null>> = {
  appendUploadedPhotos: null,
  renameStation: ((id: string) => `rename:${id}`) as (...args: never[]) => string,
  updateStationNote: ((id: string) => `stationNote:${id}`) as (...args: never[]) => string,
  mergeWithNextStation: null,
  splitStationAtPhoto: null,
  deleteStation: null,
  togglePhotoIncluded: null,
  updatePhotoNote: ((id: string) => `photoNote:${id}`) as (...args: never[]) => string,
  deletePhoto: null,
  undoDeletePhoto: null,
  updateStationPages: null,
  resetStationPages: null,
  setCoverPhoto: null,
  reorderPhotoInStation: null,
  movePhotoToStation: null,
  createManualStationWithPhotos: null,
  assignManualLocationToPhotos: null,
  updateJourneyTitle: (() => 'title') as (...args: never[]) => string,
  updateSettings: ((partial: Partial<JourneySettings>) => `settings:${Object.keys(partial).sort().join(',')}`) as (
    ...args: never[]
  ) => string,
  setTravelerAvatar: null,
  setCustomMusic: null,
  reclusterWithRadius: null
}

/** 把上列操作包上「記錄編輯前狀態」的外層 */
function withUndoHistory(set: StoreSet, get: () => JourneyStoreState, state: JourneyStoreState): JourneyStoreState {
  const wrapped = { ...state } as Record<string, unknown>
  for (const [name, keyOf] of Object.entries(HISTORY_ACTIONS)) {
    const original = state[name as keyof JourneyStoreState] as unknown as AnyAction
    wrapped[name] = (...args: never[]) => {
      const before = get().journey
      const result = original(...args)
      const after = get().journey
      // 還沒有任何照片時（第一次選照片）不記錄，避免復原到空白旅程
      if (after !== before && Object.keys(before.photos).length > 0) {
        set({ history: recordHistory(get().history, before, keyOf ? keyOf(...args) : null, Date.now()) })
      }
      return result
    }
  }
  return wrapped as unknown as JourneyStoreState
}

export const useJourneyStore = create<JourneyStoreState>((set, get) => withUndoHistory(set, get, {
  currentStep: 1,
  journey: createEmptyJourney(),
  groundRoutes: {},
  geocodingProgress: { isQuerying: false, completed: 0, total: 0 },
  pendingDraft: null,
  draftChecked: false,
  lastDeletedPhoto: null,
  history: createEmptyHistory(),
  historyNotice: null,

  undo: () => {
    const { history, journey } = get()
    const result = undoHistory(history, journey)
    if (!result) return
    set({
      journey: result.journey,
      history: result.history,
      lastDeletedPhoto: null,
      historyNotice: { kind: 'undo', at: Date.now() }
    })
    void saveJourneyDraft(result.journey)
    // 復原後站點組合可能不同，補查地名與陸路路線（已查過的會直接用快取）
    void get().refreshStationNamesAndRoutes()
  },

  redo: () => {
    const { history, journey } = get()
    const result = redoHistory(history, journey)
    if (!result) return
    set({
      journey: result.journey,
      history: result.history,
      lastDeletedPhoto: null,
      historyNotice: { kind: 'redo', at: Date.now() }
    })
    void saveJourneyDraft(result.journey)
    void get().refreshStationNamesAndRoutes()
  },

  setCurrentStep: (step) => set({ currentStep: step }),

  checkInitialDraft: async () => {
    const draft = await loadJourneyDraft()
    // 讀取草稿期間使用者若已經開始選照片，就不再詢問（否則「開始新的旅程」會清掉正在進行的工作）
    const alreadyStarted = Object.keys(get().journey.photos).length > 0
    set({
      pendingDraft: alreadyStarted ? null : draft,
      draftChecked: true
    })
  },

  resumePendingDraft: () => {
    const { pendingDraft } = get()
    if (!pendingDraft) return
    set({
      journey: pendingDraft,
      pendingDraft: null,
      currentStep: 2,
      history: createEmptyHistory()
    })
    void get().refreshStationNamesAndRoutes()
  },

  discardPendingDraftAndReset: async () => {
    await clearJourneyDraft()
    set({
      journey: createEmptyJourney(),
      pendingDraft: null,
      groundRoutes: {},
      currentStep: 1,
      history: createEmptyHistory()
    })
  },

  appendUploadedPhotos: (newPhotos) => {
    const state = get()
    const mergedPhotos: Record<string, Photo> = { ...state.journey.photos }
    for (const p of newPhotos) {
      mergedPhotos[p.id] = p
    }

    const clustered = clusterPhotosIntoStations(
      mergedPhotos,
      state.journey.settings.stationRadiusKm
    )

    const coverPhotoId = pickDefaultCoverPhotoId(
      clustered.photos,
      clustered.stations,
      state.journey.coverPhotoId
    )

    const title = state.journey.isTitleCustomized
      ? state.journey.title
      : generateJourneyTitle(clustered.stations)

    const nextJourney: Journey = {
      ...state.journey,
      photos: clustered.photos,
      stations: clustered.stations,
      unassignedPhotoIds: clustered.unassignedPhotoIds,
      coverPhotoId,
      title,
      hasManualStationEdits: false
    }

    set({ journey: nextJourney })
    void saveJourneyDraft(nextJourney)
    void get().refreshStationNamesAndRoutes()
  },

  renameStation: (stationId, customName) => {
    const { journey } = get()
    const stations = journey.stations.map((st) =>
      st.id === stationId
        ? { ...st, customName: customName.trim() ? customName : undefined }
        : st
    )
    const title = journey.isTitleCustomized
      ? journey.title
      : generateJourneyTitle(stations)
    const nextJourney: Journey = {
      ...journey,
      stations,
      title,
      hasManualStationEdits: true
    }
    set({ journey: nextJourney })
    void saveJourneyDraft(nextJourney)
  },

  updateStationNote: (stationId, note) => {
    const { journey } = get()
    const stations = journey.stations.map((st) =>
      st.id === stationId ? { ...st, note } : st
    )
    const nextJourney: Journey = {
      ...journey,
      stations,
      hasManualStationEdits: true
    }
    set({ journey: nextJourney })
    void saveJourneyDraft(nextJourney)
  },

  mergeWithNextStation: (stationId) => {
    const { journey } = get()
    const idx = journey.stations.findIndex((s) => s.id === stationId)
    if (idx < 0 || idx >= journey.stations.length - 1) return

    const first = journey.stations[idx]
    const second = journey.stations[idx + 1]
    const combinedPhotoIds = [...first.photoIds, ...second.photoIds]
    const combinedPhotos = combinedPhotoIds
      .map((id) => journey.photos[id])
      .filter((p): p is Photo => Boolean(p))

    const newCenter = computeStationCenter(combinedPhotos, first.center)
    // 任一站手動分頁過，就把兩站目前的分頁接起來，保留使用者的設定
    const mergedPages =
      first.pages || second.pages
        ? [
            ...resolveStationPages(first, journey.photos, journey.settings),
            ...resolveStationPages(second, journey.photos, journey.settings)
          ]
        : undefined
    const mergedStation: Station = {
      ...first,
      photoIds: combinedPhotoIds,
      pages: mergedPages,
      center: newCenter,
      note: first.note || second.note
    }

    const stations = [
      ...journey.stations.slice(0, idx),
      mergedStation,
      ...journey.stations.slice(idx + 2)
    ]

    const title = journey.isTitleCustomized
      ? journey.title
      : generateJourneyTitle(stations)

    const nextJourney: Journey = {
      ...journey,
      stations,
      title,
      hasManualStationEdits: true
    }
    set({ journey: nextJourney })
    void saveJourneyDraft(nextJourney)
    void get().refreshStationNamesAndRoutes()
  },

  splitStationAtPhoto: (stationId, splitFromPhotoId) => {
    const { journey } = get()
    const stIdx = journey.stations.findIndex((s) => s.id === stationId)
    if (stIdx < 0) return

    const targetStation = journey.stations[stIdx]
    const photoIdx = targetStation.photoIds.indexOf(splitFromPhotoId)
    if (photoIdx <= 0) return

    const firstIds = targetStation.photoIds.slice(0, photoIdx)
    const secondIds = targetStation.photoIds.slice(photoIdx)

    const firstPhotos = firstIds.map((id) => journey.photos[id]).filter(Boolean)
    const secondPhotos = secondIds.map((id) => journey.photos[id]).filter(Boolean)

    // 拆分前若有手動分頁，兩站各自清理掉已移往另一側的照片，並依剩餘張數校正失效的版面樣式
    const cleanSplitPages = (subIds: string[]): StationPage[] | undefined => {
      if (!targetStation.pages) return undefined
      const cleaned = resolveStationPages({ ...targetStation, photoIds: subIds }, journey.photos, journey.settings)
      return cleaned.map((page) =>
        page.photoIds.length <= 1 && page.layout && page.layout !== 'single'
          ? { ...page, layout: undefined }
          : page
      )
    }

    const stationA: Station = {
      ...targetStation,
      photoIds: firstIds,
      pages: cleanSplitPages(firstIds),
      center: computeStationCenter(firstPhotos, targetStation.center)
    }

    // 新站點的中心點已改變，先給暫定名稱，背景查詢會補上正確地名
    const stationB: Station = {
      id: createStationId(),
      photoIds: secondIds,
      pages: cleanSplitPages(secondIds),
      center: computeStationCenter(secondPhotos, targetStation.center),
      autoName: `站點 ${stIdx + 2}`
    }

    const stations = [
      ...journey.stations.slice(0, stIdx),
      stationA,
      stationB,
      ...journey.stations.slice(stIdx + 1)
    ]

    const nextJourney: Journey = {
      ...journey,
      stations,
      hasManualStationEdits: true
    }
    set({ journey: nextJourney })
    void saveJourneyDraft(nextJourney)
    void get().refreshStationNamesAndRoutes()
  },

  deleteStation: (stationId) => {
    // 依據規格書 §4.3：刪除站點 → 該站所有照片改為不入選
    const { journey } = get()
    const target = journey.stations.find((s) => s.id === stationId)
    if (!target) return

    const photos = { ...journey.photos }
    for (const pid of target.photoIds) {
      if (photos[pid]) {
        photos[pid] = { ...photos[pid], included: false }
      }
    }

    const nextJourney: Journey = {
      ...journey,
      photos,
      coverPhotoId: pickDefaultCoverPhotoId(photos, journey.stations, journey.coverPhotoId),
      hasManualStationEdits: true
    }
    set({ journey: nextJourney })
    void saveJourneyDraft(nextJourney)
    // 有效站點組合改變，補查新相鄰站點間的陸路路線
    void get().refreshStationNamesAndRoutes()
  },

  togglePhotoIncluded: (photoId) => {
    const { journey } = get()
    const target = journey.photos[photoId]
    if (!target) return

    const photos = {
      ...journey.photos,
      [photoId]: { ...target, included: !target.included }
    }

    const nextJourney: Journey = {
      ...journey,
      photos,
      coverPhotoId: pickDefaultCoverPhotoId(photos, journey.stations, journey.coverPhotoId)
    }
    set({ journey: nextJourney })
    void saveJourneyDraft(nextJourney)
    // 若某站點因此變成（或不再是）有效站點，相鄰站點組合會改變
    void get().refreshStationNamesAndRoutes()
  },

  updatePhotoNote: (photoId, note) => {
    const { journey } = get()
    const target = journey.photos[photoId]
    if (!target) return

    const photos = {
      ...journey.photos,
      [photoId]: { ...target, note }
    }
    const nextJourney: Journey = { ...journey, photos }
    set({ journey: nextJourney })
    void saveJourneyDraft(nextJourney)
  },

  deletePhoto: (photoId) => {
    const { journey } = get()
    const photo = journey.photos[photoId]
    if (!photo) return

    const station = journey.stations.find((st) => st.photoIds.includes(photoId))
    const undo: DeletedPhotoUndo = {
      photo,
      stationId: station?.id,
      indexInStation: station ? station.photoIds.indexOf(photoId) : -1,
      stationPagesBefore: station?.pages,
      unassignedIndex: journey.unassignedPhotoIds.indexOf(photoId),
      wasCover: journey.coverPhotoId === photoId
    }

    const photos = { ...journey.photos }
    delete photos[photoId]
    const stations = journey.stations
      .map((st) => {
        if (!st.photoIds.includes(photoId)) return st
        const remaining = st.photoIds.filter((id) => id !== photoId)
        const stPhotos = remaining.map((id) => photos[id]).filter(Boolean)
        return { ...st, photoIds: remaining, center: computeStationCenter(stPhotos, st.center) }
      })
      .filter((st) => st.photoIds.length > 0)

    const nextJourney: Journey = {
      ...journey,
      photos,
      stations,
      unassignedPhotoIds: journey.unassignedPhotoIds.filter((id) => id !== photoId),
      coverPhotoId: pickDefaultCoverPhotoId(photos, stations, undo.wasCover ? undefined : journey.coverPhotoId),
      hasManualStationEdits: true
    }
    set({ journey: nextJourney, lastDeletedPhoto: undo })
    void saveJourneyDraft(nextJourney)
    void get().refreshStationNamesAndRoutes()
  },

  undoDeletePhoto: () => {
    const { journey, lastDeletedPhoto: undo } = get()
    if (!undo) return
    const photos = { ...journey.photos, [undo.photo.id]: undo.photo }

    let stations = journey.stations
    const station = undo.stationId ? stations.find((st) => st.id === undo.stationId) : undefined
    if (station) {
      const ids = [...station.photoIds]
      ids.splice(Math.min(Math.max(0, undo.indexInStation), ids.length), 0, undo.photo.id)
      const stPhotos = ids.map((id) => photos[id]).filter(Boolean)
      stations = stations.map((st) =>
        st.id === station.id
          ? {
              ...st,
              photoIds: ids,
              pages: undo.stationPagesBefore ?? st.pages,
              center: computeStationCenter(stPhotos, st.center)
            }
          : st
      )
    }

    const unassignedPhotoIds = [...journey.unassignedPhotoIds]
    if (!station) {
      // 原本是未歸類照片，或原站點已不存在：放回未歸類區
      const at = undo.unassignedIndex >= 0 ? undo.unassignedIndex : unassignedPhotoIds.length
      unassignedPhotoIds.splice(Math.min(at, unassignedPhotoIds.length), 0, undo.photo.id)
    }

    const nextJourney: Journey = {
      ...journey,
      photos,
      stations,
      unassignedPhotoIds,
      coverPhotoId: undo.wasCover ? undo.photo.id : journey.coverPhotoId
    }
    set({ journey: nextJourney, lastDeletedPhoto: null })
    void saveJourneyDraft(nextJourney)
    void get().refreshStationNamesAndRoutes()
  },

  dismissDeletedPhoto: () => set({ lastDeletedPhoto: null }),

  updateStationPages: (stationId, pages) => {
    const { journey } = get()
    const stations = journey.stations.map((st) =>
      st.id === stationId
        ? { ...st, pages, photoIds: pages.flatMap((p) => p.photoIds) }
        : st
    )
    const nextJourney: Journey = { ...journey, stations, hasManualStationEdits: true }
    set({ journey: nextJourney })
    void saveJourneyDraft(nextJourney)
  },

  resetStationPages: (stationId) => {
    const { journey } = get()
    const stations = journey.stations.map((st) => {
      if (st.id !== stationId) return st
      const cleared: Station = { ...st, pages: undefined }
      const autoPages = resolveStationPages(cleared, journey.photos, journey.settings)
      return {
        ...cleared,
        photoIds: autoPages.flatMap((p) => p.photoIds)
      }
    })
    const nextJourney: Journey = { ...journey, stations }
    set({ journey: nextJourney })
    void saveJourneyDraft(nextJourney)
  },

  setCoverPhoto: (photoId) => {
    const { journey } = get()
    const target = journey.photos[photoId]
    if (!target) return
    // 手動將未入選的照片設為封面時，一併勾回入選，確保片頭與入選狀態一致
    const photos = target.included
      ? journey.photos
      : { ...journey.photos, [photoId]: { ...target, included: true } }
    const nextJourney: Journey = { ...journey, photos, coverPhotoId: photoId }
    set({ journey: nextJourney })
    void saveJourneyDraft(nextJourney)
    if (!target.included) {
      void get().refreshStationNamesAndRoutes()
    }
  },

  reorderPhotoInStation: (stationId, fromIndex, toIndex) => {
    const { journey } = get()
    const stations = journey.stations.map((st) => {
      if (st.id !== stationId) return st
      if (
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= st.photoIds.length ||
        toIndex >= st.photoIds.length
      ) {
        return st
      }
      const nextIds = [...st.photoIds]
      const [moved] = nextIds.splice(fromIndex, 1)
      nextIds.splice(toIndex, 0, moved)
      return { ...st, photoIds: nextIds }
    })

    const nextJourney: Journey = {
      ...journey,
      stations,
      hasManualStationEdits: true
    }
    set({ journey: nextJourney })
    void saveJourneyDraft(nextJourney)
  },

  movePhotoToStation: (photoId, targetStationId) => {
    const { journey } = get()
    const photo = journey.photos[photoId]
    if (!photo) return

    const unassignedPhotoIds = journey.unassignedPhotoIds.filter((id) => id !== photoId)
    const stations = journey.stations
      .map((st) => {
        const filtered = st.photoIds.filter((id) => id !== photoId)
        if (st.id === targetStationId) {
          filtered.push(photoId)
        }
        const stPhotos = filtered.map((id) => journey.photos[id]).filter(Boolean)
        return {
          ...st,
          photoIds: filtered,
          center: computeStationCenter(stPhotos, st.center)
        }
      })
      .filter((st) => st.photoIds.length > 0)

    const targetSt = stations.find((s) => s.id === targetStationId)
    const updatedPhotos = { ...journey.photos }
    if (targetSt && updatedPhotos[photoId].locationSource === 'none') {
      updatedPhotos[photoId] = {
        ...updatedPhotos[photoId],
        locationSource: 'inferred',
        coordinates: { ...targetSt.center }
      }
    }

    const nextJourney: Journey = {
      ...journey,
      photos: updatedPhotos,
      stations,
      unassignedPhotoIds,
      hasManualStationEdits: true
    }
    set({ journey: nextJourney })
    void saveJourneyDraft(nextJourney)
    void get().refreshStationNamesAndRoutes()
  },

  createManualStationWithPhotos: (name, coords, photoIds) => {
    const { journey } = get()
    if (photoIds.length === 0) return

    const idSet = new Set(photoIds)
    const photos = { ...journey.photos }
    for (const pid of photoIds) {
      if (photos[pid]) {
        photos[pid] = {
          ...photos[pid],
          coordinates: { ...coords },
          locationSource: 'manual',
          included: true
        }
      }
    }

    const unassignedPhotoIds = journey.unassignedPhotoIds.filter((id) => !idSet.has(id))
    const cleanedStations = journey.stations
      .map((st) => ({
        ...st,
        photoIds: st.photoIds.filter((id) => !idSet.has(id))
      }))
      .filter((st) => st.photoIds.length > 0)

    const newStation: Station = {
      id: createStationId(),
      photoIds: [...photoIds],
      center: { ...coords },
      autoName: name.trim() || `${coords.latitude.toFixed(2)}, ${coords.longitude.toFixed(2)}`,
      customName: name.trim() || undefined
    }

    const stations = [...cleanedStations, newStation].sort(
      (a, b) => getStationEarliestTime(a, photos) - getStationEarliestTime(b, photos)
    )

    const title = journey.isTitleCustomized
      ? journey.title
      : generateJourneyTitle(stations)

    const nextJourney: Journey = {
      ...journey,
      photos,
      stations,
      unassignedPhotoIds,
      title,
      coverPhotoId: pickDefaultCoverPhotoId(photos, stations, journey.coverPhotoId),
      hasManualStationEdits: true
    }
    set({ journey: nextJourney })
    void saveJourneyDraft(nextJourney)
    void get().refreshStationNamesAndRoutes()
  },

  assignManualLocationToPhotos: (photoIds, coords, placeName) => {
    const { journey } = get()
    if (photoIds.length === 0) return

    const photos = { ...journey.photos }
    for (const id of photoIds) {
      if (photos[id]) {
        photos[id] = {
          ...photos[id],
          coordinates: { ...coords },
          locationSource: 'manual'
        }
      }
    }

    if (!journey.hasManualStationEdits) {
      const clustered = clusterPhotosIntoStations(
        photos,
        journey.settings.stationRadiusKm
      )
      const nextJourney: Journey = {
        ...journey,
        photos: clustered.photos,
        stations: clustered.stations,
        unassignedPhotoIds: clustered.unassignedPhotoIds,
        coverPhotoId: pickDefaultCoverPhotoId(
          clustered.photos,
          clustered.stations,
          journey.coverPhotoId
        )
      }
      set({ journey: nextJourney })
      void saveJourneyDraft(nextJourney)
      void get().refreshStationNamesAndRoutes()
    } else {
      get().createManualStationWithPhotos(placeName || '自訂站點', coords, photoIds)
    }
  },

  updateJourneyTitle: (title) => {
    const { journey } = get()
    const nextJourney: Journey = {
      ...journey,
      title,
      isTitleCustomized: true
    }
    set({ journey: nextJourney })
    void saveJourneyDraft(nextJourney)
  },

  updateSettings: (partial) => {
    const { journey } = get()
    const nextSettings: JourneySettings = {
      ...journey.settings,
      ...partial
    }
    const nextJourney: Journey = {
      ...journey,
      settings: nextSettings
    }
    set({ journey: nextJourney })
    void saveJourneyDraft(nextJourney)

    if (partial.longDistanceThresholdKm !== undefined) {
      void get().refreshStationNamesAndRoutes()
    }
  },

  setTravelerAvatar: (avatar) => {
    const { journey } = get()
    const nextJourney: Journey = {
      ...journey,
      travelerAvatar: avatar,
      settings: {
        ...journey.settings,
        travelerMarker: avatar ? 'avatar' : journey.settings.travelerMarker === 'avatar' ? 'dot' : journey.settings.travelerMarker
      }
    }
    set({ journey: nextJourney })
    void saveJourneyDraft(nextJourney)
  },

  setCustomMusic: (music) => {
    const { journey } = get()
    const current = journey.settings.music
    const nextJourney: Journey = {
      ...journey,
      customMusic: music,
      settings: {
        ...journey.settings,
        music: { ...current, source: music ? 'custom' : current.source === 'custom' ? 'none' : current.source }
      }
    }
    set({ journey: nextJourney })
    void saveJourneyDraft(nextJourney)
  },

  reclusterWithRadius: (newRadiusKm) => {
    const { journey } = get()
    const clustered = clusterPhotosIntoStations(journey.photos, newRadiusKm)
    const nextSettings: JourneySettings = {
      ...journey.settings,
      stationRadiusKm: newRadiusKm
    }
    const title = journey.isTitleCustomized
      ? journey.title
      : generateJourneyTitle(clustered.stations)

    const nextJourney: Journey = {
      ...journey,
      photos: clustered.photos,
      stations: clustered.stations,
      unassignedPhotoIds: clustered.unassignedPhotoIds,
      settings: nextSettings,
      title,
      hasManualStationEdits: false
    }

    set({ journey: nextJourney })
    void saveJourneyDraft(nextJourney)
    void get().refreshStationNamesAndRoutes()
  },

  refreshStationNamesAndRoutes: async () => {
    const generation = ++refreshGeneration
    const isStale = () => generation !== refreshGeneration

    // 1. 查詢尚未取得正式地名的站點（暫定名稱為「站點 N」）
    const pendingStations = get().journey.stations.filter((st) =>
      PLACEHOLDER_STATION_NAME_PATTERN.test(st.autoName)
    )
    const needsNetwork = pendingStations.some((st) => !hasCachedReverseGeocode(st.center))

    if (pendingStations.length > 0) {
      set({
        geocodingProgress: {
          isQuerying: needsNetwork,
          completed: 0,
          total: pendingStations.length
        }
      })
    }

    for (let i = 0; i < pendingStations.length; i++) {
      const target = pendingStations[i]
      const geo = await reverseGeocodeStationCenter(target.center, isStale)
      if (isStale()) return

      const currentJourney = get().journey
      const current = currentJourney.stations.find((s) => s.id === target.id)
      // 查詢期間站點被合併／拆分而改變中心點時，捨棄這筆過期結果；查詢失敗則保留暫定名稱以便之後重試
      if (!geo.failed && current && isSameCoordinates(current.center, target.center)) {
        const updatedStations = currentJourney.stations.map((s) =>
          s.id === target.id
            ? { ...s, autoName: geo.formattedName, cityName: geo.cityName, countryName: geo.countryName }
            : s
        )
        const nextJourney: Journey = {
          ...currentJourney,
          stations: updatedStations,
          title: currentJourney.isTitleCustomized
            ? currentJourney.title
            : generateJourneyTitle(updatedStations)
        }
        set({ journey: nextJourney })
        void saveJourneyDraft(nextJourney)
      }

      set({
        geocodingProgress: {
          isQuerying: needsNetwork && i + 1 < pendingStations.length,
          completed: i + 1,
          total: pendingStations.length
        }
      })
    }

    // 2. 查詢短途站點間的 OSRM 陸路路線（以起訖座標為快取鍵）
    const currentJourney = get().journey
    const activeStations = currentJourney.stations.filter((st) =>
      st.photoIds.some((id) => currentJourney.photos[id]?.included)
    )

    for (let i = 1; i < activeStations.length; i++) {
      const prev = activeStations[i - 1]
      const curr = activeStations[i]
      const kind = resolveRouteKind(
        prev.center,
        curr.center,
        currentJourney.settings.longDistanceThresholdKm
      )
      const key = groundRouteKey(prev.center, curr.center)
      if (kind === 'ground' && !get().groundRoutes[key]) {
        const { route, isFallback } = await fetchGroundRouteWithFallback(prev.center, curr.center)
        if (isStale()) return
        // 降級曲線不寫入快取：時間軸在沒有快取時本來就會畫平滑曲線，之後重新整理會再試 OSRM
        if (!isFallback) set({ groundRoutes: { ...get().groundRoutes, [key]: route } })
      }
    }
  }
}))
