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

/** 移動段框住起訖點的最大推近層級（避免短距離移動看到街道細節） */
export const MAX_CAMERA_FIT_ZOOM = 10

/** 移動段四周留白比例 */
export const CAMERA_FIT_PADDING_RATIO = 0.25

/** Nominatim 反向地理編碼最小請求間隔（毫秒） */
export const NOMINATIM_MIN_INTERVAL_MS = 1100

/** 預設旅程設定 */
export const DEFAULT_JOURNEY_SETTINGS: JourneySettings = {
  stationRadiusKm: 10,
  longDistanceThresholdKm: 100,
  secondsPerCell: 2,
  autoCollage: true,
  orientation: 'landscape',
  resolution: '1080p'
}

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
