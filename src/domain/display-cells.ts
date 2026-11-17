import type { DisplayCell, Photo, VideoOrientation } from '../types/journey'

/**
 * 判斷單張照片是否為直拍（高 > 寬）
 * @param photo 照片
 */
export function isPortraitPhoto(photo: Photo): boolean {
  return photo.height > photo.width
}

/**
 * 判斷照片方向是否與影片方向不一致（可參與拼圖）
 * - 橫式影片（landscape）：直拍照片（height > width）可拼圖
 * - 直式影片（portrait）：橫拍照片（width >= height）可拼圖
 * @param photo 照片
 * @param videoOrientation 影片方向
 */
export function isPhotoEligibleForCollage(
  photo: Photo,
  videoOrientation: VideoOrientation
): boolean {
  if (videoOrientation === 'landscape') {
    return photo.height > photo.width
  }
  return photo.width >= photo.height
}

// NOTE: 站點內的分頁、拼接樣式與運鏡已移到 domain/pages.ts（buildAutoPages / buildStationCells）

/**
 * 依據規格書 §2.3 計算展示格左下角的三行文字
 * 1. 第一行（粗體大字）：站點顯示名稱（customName 優先於 autoName）
 * 2. 第二行（中字）：該展示格第一張照片的當地日期（YYYY年M月D日）
 * 3. 第三行（小字，可省略）：
 *    - 單張格：有照片備註顯示照片備註；否則有站點備註顯示站點備註；都沒有則不顯示
 *    - 拼圖格：取格內第一張有照片備註的照片；皆無則用站點備註
 */
export function resolveDisplayCellOverlayText(
  cell: Pick<DisplayCell, 'photoIds'>,
  photosMap: Record<string, Photo>,
  stationName: string,
  stationNote?: string
): {
  line1Title: string
  line2Date: string
  line3Note?: string
} {
  const cellPhotos = cell.photoIds
    .map((id) => photosMap[id])
    .filter((p): p is Photo => Boolean(p))

  const firstPhoto = cellPhotos[0]
  let line2Date = ''
  if (firstPhoto?.localDate) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(firstPhoto.localDate.trim())
    if (match) {
      line2Date = `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`
    } else {
      line2Date = firstPhoto.localDate
    }
  }

  const photoWithNote = cellPhotos.find((p) => p.note && p.note.trim().length > 0)
  const resolvedNote = photoWithNote?.note?.trim() || stationNote?.trim() || undefined

  return {
    line1Title: stationName,
    line2Date,
    line3Note: resolvedNote
  }
}
