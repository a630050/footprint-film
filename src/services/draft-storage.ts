import { openDB, type IDBPDatabase } from 'idb'
import { DEFAULT_JOURNEY_SETTINGS } from '../constants/video-config'
import type { Journey, Photo } from '../types/journey'

const DB_NAME = 'travel-video-web-db'
const DB_VERSION = 2
const DRAFT_STORE = 'drafts'
const PHOTO_BLOB_STORE = 'photo-blobs'
const SINGLE_DRAFT_KEY = 'current-journey-draft'

/** 草稿寫入延遲（毫秒）：連續輸入備註時只在停頓後寫一次 */
const DRAFT_SAVE_DEBOUNCE_MS = 600

/** 草稿中的照片：影像 Blob 另存於 photo-blobs，避免每次編輯都重寫數十 MB 的影像 */
type StoredPhoto = Omit<Photo, 'imageBlob'> & { imageBlob?: Blob }
type StoredJourney = Omit<Journey, 'photos' | 'customMusic' | 'travelerAvatar'> & {
  photos: Record<string, StoredPhoto>
  /** 上傳的配樂只存檔名，音樂檔本身另存於 photo-blobs（key: CUSTOM_MUSIC_KEY） */
  customMusic?: { fileName: string; blob?: Blob }
  /** 舊版草稿可能內嵌 travelerAvatar Blob；新版改存於 photo-blobs（key: TRAVELER_AVATAR_KEY）並以此標記 */
  travelerAvatar?: Blob
  hasTravelerAvatar?: boolean
}

/** 使用者上傳配樂在 photo-blobs 中的 key */
const CUSTOM_MUSIC_KEY = 'music:custom'
/** 使用者裁切大頭照在 photo-blobs 中的 key */
const TRAVELER_AVATAR_KEY = 'avatar:traveler'
/** 已寫入的配樂 Blob（同一份不重複寫入） */
let persistedMusicBlob: Blob | null = null
/** 已寫入的大頭照 Blob（同一份不重複寫入） */
let persistedAvatarBlob: Blob | null = null

let dbPromise: Promise<IDBPDatabase> | null = null

/** 已確定寫入 IndexedDB 的照片 Blob ID（同一份 Blob 不重複寫入） */
const persistedBlobIds = new Set<string>()

let pendingJourney: Journey | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let writeChain: Promise<void> = Promise.resolve()

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(DRAFT_STORE)) {
          db.createObjectStore(DRAFT_STORE)
        }
        if (!db.objectStoreNames.contains(PHOTO_BLOB_STORE)) {
          db.createObjectStore(PHOTO_BLOB_STORE)
        }
      }
    })
  }
  return dbPromise
}

async function writeDraftNow(journey: Journey): Promise<void> {
  try {
    const db = await getDb()
    const tx = db.transaction([DRAFT_STORE, PHOTO_BLOB_STORE], 'readwrite')
    const blobStore = tx.objectStore(PHOTO_BLOB_STORE)

    const photos: Record<string, StoredPhoto> = {}
    const newlyWritten: string[] = []
    for (const [id, photo] of Object.entries(journey.photos)) {
      const { imageBlob, ...meta } = photo
      photos[id] = meta
      if (!persistedBlobIds.has(id)) {
        void blobStore.put(imageBlob, id)
        newlyWritten.push(id)
      }
    }

    // 已刪除照片的影像一併從草稿移除，避免佔用儲存空間
    for (const id of [...persistedBlobIds]) {
      if (!journey.photos[id]) {
        void blobStore.delete(id)
        persistedBlobIds.delete(id)
      }
    }

    // 上傳的配樂可能有數 MB，只在更換時寫入一次
    const music = journey.customMusic
    if (music && music.blob !== persistedMusicBlob) {
      void blobStore.put(music.blob, CUSTOM_MUSIC_KEY)
    } else if (!music && persistedMusicBlob) {
      void blobStore.delete(CUSTOM_MUSIC_KEY)
    }

    // 移動標記大頭照同樣獨立存於 photo-blobs，避免每次文字編輯重複序列化
    const avatar = journey.travelerAvatar
    if (avatar && avatar !== persistedAvatarBlob) {
      void blobStore.put(avatar, TRAVELER_AVATAR_KEY)
    } else if (!avatar && persistedAvatarBlob) {
      void blobStore.delete(TRAVELER_AVATAR_KEY)
    }

    const { travelerAvatar: _omitAvatar, ...journeyRest } = journey
    const stored: StoredJourney = {
      ...journeyRest,
      photos,
      customMusic: music ? { fileName: music.fileName } : undefined,
      hasTravelerAvatar: Boolean(avatar)
    }
    void tx.objectStore(DRAFT_STORE).put(stored, SINGLE_DRAFT_KEY)
    await tx.done
    for (const id of newlyWritten) persistedBlobIds.add(id)
    persistedMusicBlob = music?.blob ?? null
    persistedAvatarBlob = avatar ?? null
  } catch {
    // 隱私模式或儲存空間不足時忽略錯誤，不中斷使用者操作
  }
}

/**
 * 依據規格書 §4.6 排程寫入目前旅程草稿（自動延遲合併，連續編輯只寫最後一次）
 * @param journey 旅程狀態
 */
export function saveJourneyDraft(journey: Journey): Promise<void> {
  pendingJourney = journey
  if (saveTimer) clearTimeout(saveTimer)
  return new Promise<void>((resolve) => {
    saveTimer = setTimeout(() => {
      saveTimer = null
      resolve(flushJourneyDraft())
    }, DRAFT_SAVE_DEBOUNCE_MS)
  })
}

/**
 * 立即寫入尚未寫入的草稿（分頁即將被切到背景或關閉時呼叫）
 */
export function flushJourneyDraft(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const journey = pendingJourney
  pendingJourney = null
  if (!journey) return writeChain
  writeChain = writeChain.then(() => writeDraftNow(journey))
  return writeChain
}

/**
 * 讀取上次保存的旅程草稿
 * @returns 若有有效草稿則回傳 Journey，否則回傳 null
 */
export async function loadJourneyDraft(): Promise<Journey | null> {
  try {
    const db = await getDb()
    const stored = (await db.get(DRAFT_STORE, SINGLE_DRAFT_KEY)) as StoredJourney | undefined
    if (!stored || !stored.photos || Object.keys(stored.photos).length === 0) {
      return null
    }

    const photos: Record<string, Photo> = {}
    for (const [id, meta] of Object.entries(stored.photos)) {
      // v1 草稿直接內嵌 Blob；v2 草稿的 Blob 另存
      const blob = meta.imageBlob ?? ((await db.get(PHOTO_BLOB_STORE, id)) as Blob | undefined)
      if (!blob) continue
      photos[id] = { ...meta, imageBlob: blob }
      if (!meta.imageBlob) persistedBlobIds.add(id)
    }

    if (Object.keys(photos).length === 0) return null

    let customMusic: Journey['customMusic']
    if (stored.customMusic) {
      const blob = stored.customMusic.blob ?? ((await db.get(PHOTO_BLOB_STORE, CUSTOM_MUSIC_KEY)) as Blob | undefined)
      if (blob) {
        customMusic = { blob, fileName: stored.customMusic.fileName }
        if (!stored.customMusic.blob) persistedMusicBlob = blob
      }
    }

    let travelerAvatar: Blob | undefined = stored.travelerAvatar
    if (!travelerAvatar && stored.hasTravelerAvatar) {
      const blob = (await db.get(PHOTO_BLOB_STORE, TRAVELER_AVATAR_KEY)) as Blob | undefined
      if (blob) {
        travelerAvatar = blob
        persistedAvatarBlob = blob
      }
    } else if (travelerAvatar) {
      persistedAvatarBlob = travelerAvatar
    }

    // 移除找不到影像的照片參照，避免後續渲染出錯
    const exists = (id: string) => Boolean(photos[id])
    const { hasTravelerAvatar: _hasAvatar, ...storedJourney } = stored
    return {
      ...storedJourney,
      photos,
      customMusic,
      travelerAvatar,
      // 舊版草稿沒有新增的設定欄位（例如移動標記），以預設值補齊
      settings: { ...DEFAULT_JOURNEY_SETTINGS, ...stored.settings },
      stations: stored.stations
        .map((st) => ({ ...st, photoIds: st.photoIds.filter(exists) }))
        .filter((st) => st.photoIds.length > 0),
      unassignedPhotoIds: stored.unassignedPhotoIds.filter(exists),
      coverPhotoId: stored.coverPhotoId && exists(stored.coverPhotoId) ? stored.coverPhotoId : undefined
    }
  } catch {
    return null
  }
}

/**
 * 清除 IndexedDB 中的旅程草稿（含所有照片影像）
 */
export async function clearJourneyDraft(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  pendingJourney = null
  try {
    await writeChain
    const db = await getDb()
    const tx = db.transaction([DRAFT_STORE, PHOTO_BLOB_STORE], 'readwrite')
    void tx.objectStore(DRAFT_STORE).clear()
    void tx.objectStore(PHOTO_BLOB_STORE).clear()
    await tx.done
    persistedBlobIds.clear()
    persistedMusicBlob = null
    persistedAvatarBlob = null
  } catch {
    // 忽略清除錯誤
  }
}

if (typeof document !== 'undefined') {
  // 手機切換 App 時分頁可能被系統直接回收，先把尚未寫入的草稿寫進去
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushJourneyDraft()
  })
  window.addEventListener('pagehide', () => {
    void flushJourneyDraft()
  })
}
