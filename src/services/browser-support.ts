/**
 * 檢查當前瀏覽器是否支援 WebCodecs API（§6：不支援時一進網站就提示改用 Chrome 或 Safari）
 * NOTE: 獨立成小模組，讓首頁不必為了這個檢查而載入整個影片編碼模組
 */
export function isWebCodecsSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.VideoEncoder !== 'undefined' &&
    typeof window.VideoFrame !== 'undefined'
  )
}
