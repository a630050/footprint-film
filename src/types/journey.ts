/**
 * 旅遊軌跡影片核心型別定義
 * NOTE: 嚴格遵循 CONTEXT.md 與 travel-video-web-spec-v2.md §7.3 之領域名詞定義
 */

/** 地理座標（WGS-84） */
export interface Coordinates {
  latitude: number
  longitude: number
}

/** 照片定位來源：exif=EXIF原始座標、inferred=依拍攝時間推定位置、manual=手動指定位置、none=無位置 */
export type LocationSource = 'exif' | 'inferred' | 'manual' | 'none'

/** 照片 */
export interface Photo {
  id: string
  fileName: string
  imageBlob: Blob                // 縮小後影像（長邊 ≤ 1920px），同時存入草稿
  width: number
  height: number
  captureTimeUtc?: number        // 拍攝時間（UTC, ms）；缺少時為 undefined
  localDate?: string             // 當地日期 'YYYY-MM-DD'
  coordinates?: Coordinates      // WGS-84
  locationSource: LocationSource // inferred = 推定位置
  included: boolean              // 入選照片
  note?: string                  // 照片備註
}

/** 站點 */
export interface Station {
  id: string
  photoIds: string[]             // 站點內順序（預設依拍攝時間）
  center: Coordinates            // 僅由 exif/manual 定位照片計算
  autoName: string               // 地名服務回傳並格式化的名稱
  customName?: string            // 使用者改名；顯示時優先
  note?: string                  // 站點備註
  countryName?: string           // 地名服務回傳的國家名稱（用於自動產生旅程標題）
  cityName?: string              // 地名服務回傳的城市名稱（用於自動產生旅程標題）
  pages?: StationPage[]          // 使用者手動分頁後才有；未設定時依連拍門檻與自動拼圖規則產生
}

/** 影片方向 */
export type VideoOrientation = 'landscape' | 'portrait'

/** 影片解析度 */
export type VideoResolution = '1080p' | '720p'

/** 移動標記樣式：dot=圓點、person=小人、avatar=使用者上傳的圓形大頭照 */
export type TravelerMarkerStyle = 'dot' | 'person' | 'avatar'

/** 旅程設定參數 */
export interface JourneySettings {
  stationRadiusKm: number        // 分站半徑，預設 10
  longDistanceThresholdKm: number // 長途門檻，預設 100
  secondsPerCell: number         // 每格秒數 1–4，預設 2
  autoCollage: boolean           // 自動拼圖，預設 true
  orientation: VideoOrientation  // 預設 landscape
  resolution: VideoResolution    // 預設 1080p
  travelerMarker: TravelerMarkerStyle // 移動段沿路線前進的標記，預設 dot
  randomMotion: boolean          // 鏡頭移動隨機：未手動設定的頁隨機分配運鏡，預設開
  randomLayout: boolean          // 拼接隨機：未手動設定的多張頁隨機分配拼接樣式，預設開
  burstThresholdSec: number      // 連拍門檻（秒）：相隔不超過此秒數的照片自動合成一頁，0 = 關閉，預設 60
  music: MusicSettings
}

/** 內建曲庫曲目代號 */
export type BuiltinTrackId = 'acoustic' | 'piano' | 'lofi' | 'cinematic' | 'summer'

/** 配樂設定 */
export interface MusicSettings {
  source: 'none' | 'builtin' | 'custom'
  builtinTrackId: BuiltinTrackId
  volume: number                 // 0 ~ 1
}

/** 旅程（同時也是草稿的內容） */
export interface Journey {
  photos: Record<string, Photo>
  stations: Station[]            // 永遠依時間排列
  unassignedPhotoIds: string[]   // 未歸類照片
  title: string                  // 旅程標題
  isTitleCustomized: boolean
  coverPhotoId?: string          // 封面照片
  hasManualStationEdits: boolean // 決定調整分站半徑時是否需要確認
  travelerAvatar?: Blob          // 裁切好的圓形大頭照（正方形 JPEG），移動標記選 avatar 時使用
  customMusic?: { blob: Blob; fileName: string } // 使用者上傳的配樂
  settings: JourneySettings
}

/**
 * 頁面拼接樣式（依張數提供不同選項，見 domain/pages.ts 的 getAvailableLayouts）
 * - single：單張（方向不合時加模糊背景）
 * - columns / rows：左右並排 / 上下並排
 * - feature-left / feature-top：左大右小 / 上大下小
 * - grid：宮格
 * - polaroid：拍立得（相片依序落下，散放在模糊背景上）
 * - burst：連拍輪動（快速輪播，像翻書）
 * - reveal：依序出現（宮格中一張張浮現）
 */
export type PageLayout =
  | 'single'
  | 'columns'
  | 'rows'
  | 'feature-left'
  | 'feature-top'
  | 'grid'
  | 'polaroid'
  | 'burst'
  | 'reveal'

/** 運鏡縮放：in=漸進（推近）、out=漸遠（拉遠）、none=不縮放 */
export type MotionZoom = 'in' | 'out' | 'none'

/** 運鏡平移方向（鏡頭往哪個方向移動），none=不平移 */
export type MotionDirection = 'none' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'

/** 頁面運鏡：套用在整頁（整張拼圖）上 */
export interface PageMotion {
  zoom: MotionZoom
  direction: MotionDirection
}

/**
 * 站點內的一頁：影片播到這個站點時一頁一頁播放
 * layout / motion 未設定時為「自動」：依設定隨機或採用預設值
 */
export interface StationPage {
  id: string
  photoIds: string[]
  layout?: PageLayout
  motion?: PageMotion
}

/** 展示格（＝已決定樣式與運鏡、可直接渲染的一頁） */
export interface DisplayCell {
  photoIds: string[]             // 只含入選照片
  durationMs: number
  layout: PageLayout
  motion: PageMotion
  seed: number                   // 拍立得角度等裝飾用的固定亂數種子
}

/** 路線類型：flight=飛行路線（大圓弧線）、ground=陸路路線（道路折線或平滑曲線） */
export type RouteKind = 'flight' | 'ground'

/** 段落時間軸 */
export type Segment =
  | { type: 'INTRO'; durationMs: number }
  | { type: 'OPENING_LOCATOR'; durationMs: number; firstStationId: string }
  | { type: 'STATION'; durationMs: number; stationId: string; cells: DisplayCell[] }
  | {
      type: 'MOVE'
      durationMs: number
      fromStationId: string
      toStationId: string
      routeKind: RouteKind
      route: [number, number][]  // [lng, lat][]
    }
  | { type: 'OUTRO'; durationMs: number }

/** 鏡頭狀態 */
export interface CameraState {
  center: [number, number]       // [lng, lat]
  zoom: number
  bearing: number
  pitch: number
}
