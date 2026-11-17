import type { JourneySettings, VideoOrientation, VideoResolution } from '../types/journey'

/** 單次上傳照片數量上限 */
export const MAX_PHOTOS_PER_BATCH = 100

/** 照片縮小後長邊最大像素 */
export const MAX_PHOTO_DIMENSION_PX = 1920

/** 影片幀率 */
export const VIDEO_FPS = 30

/** 各段落預設時長（毫秒） */
export const INTRO_DURATION_MS = 3000
export const OPENING_LOCATOR_DURATION_MS = 3000
export const MOVE_DURATION_MS = 3500
export const OUTRO_DURATION_MS = 4000

/** 轉場淡入淡出時長（毫秒） */
export const TRANSITION_FADE_MS = 500

/** 拼圖格內照片間距（像素） */
export const COLLAGE_GAP_PX = 6

/** 站點段每格放大倍率範圍 */
export const CELL_ZOOM_START = 1.0
export const CELL_ZOOM_END = 1.08

/** 開場、片尾與長途移動起點的城市層級縮放 */
export const MAX_CAMERA_FIT_ZOOM = 10

/** 全覽（開場、片尾）四周留白比例 */
export const CAMERA_FIT_PADDING_RATIO = 0.25

/**
 * 移動段框住起訖點時允許的最大推近層級：近距離站點（1–3 公里）要看得到街道，
 * 路線才會在畫面上拉得夠長，有身歷其境的感覺（zoom 16.5：東西向 1 公里約佔畫面寬度的 68%）
 */
export const MAX_MOVE_FIT_ZOOM = 16.5

/**
 * 移動段留白比例（比全覽小，讓路線佔滿更多畫面）：
 * 上方多留給終點的地名氣泡與移動標記，下方多留給「前往 …」字幕
 */
export const MOVE_FIT_PADDING = { top: 0.22, bottom: 0.2, side: 0.14 }

/** Nominatim 反向地理編碼最小請求間隔（毫秒） */
export const NOMINATIM_MIN_INTERVAL_MS = 1100

/** 預設旅程設定 */
export const DEFAULT_JOURNEY_SETTINGS: JourneySettings = {
  stationRadiusKm: 10,
  longDistanceThresholdKm: 100,
  secondsPerCell: 2,
  autoCollage: true,
  orientation: 'landscape',
  resolution: '1080p',
  travelerMarker: 'dot',
  randomMotion: true,
  randomLayout: true,
  burstThresholdSec: 60,
  music: { source: 'none', builtinTrackId: 'acoustic', volume: 0.8 }
}

/** 一頁可用拼圖版面的張數上限；超過時只能用宮格、拍立得或輪動效果 */
export const MAX_COLLAGE_PHOTOS = 4

/** 一頁最多可放的照片數（宮格 3×3） */
export const MAX_GRID_PHOTOS = 9

/** 連拍自動成頁時，一頁最多幾張（超過就切成多頁） */
export const MAX_AUTO_BURST_PHOTOS = 12

/** 連拍輪動時每張停留的秒數 */
export const BURST_SECONDS_PER_PHOTO = 0.5

/**
 * 根據影片方向與解析度取得畫布寬高
 * @param orientation 影片方向
 * @param resolution 影片解析度
 * @returns 畫布寬高像素
 */
export function getVideoDimensions(
  orientation: VideoOrientation,
  resolution: VideoResolution
): { width: number; height: number } {
  const longSide = resolution === '1080p' ? 1920 : 1280
  const shortSide = resolution === '1080p' ? 1080 : 720
  return orientation === 'landscape'
    ? { width: longSide, height: shortSide }
    : { width: shortSide, height: longSide }
}
