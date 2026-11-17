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

/**
 * 依據規格書 §3.2 產生單一站點內的展示格清單
 * 規則：
 * - 只處理入選照片（included === true）
 * - 若 autoCollage 為 false，每張入選照片各自成為一個單張展示格
 * - 若 autoCollage 為 true：
 *   - 橫式影片：同一站點內「連續」的直拍入選照片組成拼圖——能 3 張就 3 張左右並排，剩 2 張就 2 張並排，落單 1 張改以模糊背景單張顯示
 *   - 直式影片：同一站點內「連續」的橫拍入選照片上下排列，最多 2 張；落單 1 張單張顯示
 *   - 被另一方向照片隔開的照片不跨越組合（維持時間順序）
 * - 每個展示格時長皆為 secondsPerCell * 1000 毫秒
 *
 * @param stationPhotos 站點內已依順序排列的照片陣列
 * @param options 方向、每格秒數、自動拼圖開關
 * @returns 展示格陣列
 */
export function buildStationDisplayCells(
  stationPhotos: Photo[],
  options: {
    orientation: VideoOrientation
    secondsPerCell: number
    autoCollage: boolean
  }
): DisplayCell[] {
  const includedPhotos = stationPhotos.filter((p) => p.included)
  const durationMs = Math.round(options.secondsPerCell * 1000)

  if (!options.autoCollage) {
    return includedPhotos.map((p) => ({
      photoIds: [p.id],
      durationMs
    }))
  }

  const maxPerCollage = options.orientation === 'landscape' ? 3 : 2
  const cells: DisplayCell[] = []
  let i = 0

  while (i < includedPhotos.length) {
    const current = includedPhotos[i]
    if (!isPhotoEligibleForCollage(current, options.orientation)) {
      cells.push({
        photoIds: [current.id],
        durationMs
      })
      i += 1
      continue
    }

    // 收集從 i 開始連續可拼圖的照片
    const run: Photo[] = []
    while (
      i < includedPhotos.length &&
      isPhotoEligibleForCollage(includedPhotos[i], options.orientation)
    ) {
      run.push(includedPhotos[i])
      i += 1
    }

    // 依 maxPerCollage 切分這段連續照片
    let r = 0
    while (r < run.length) {
      const remaining = run.length - r
      if (maxPerCollage === 3) {
        if (remaining >= 3) {
          cells.push({
            photoIds: [run[r].id, run[r + 1].id, run[r + 2].id],
            durationMs
          })
          r += 3
        } else if (remaining === 2) {
          cells.push({
            photoIds: [run[r].id, run[r + 1].id],
            durationMs
          })
          r += 2
        } else {
          // 落單 1 張 → 單張顯示
          cells.push({
            photoIds: [run[r].id],
            durationMs
          })
          r += 1
        }
      } else {
        // 直式影片最多 2 張橫拍上下排列
        if (remaining >= 2) {
          cells.push({
            photoIds: [run[r].id, run[r + 1].id],
            durationMs
          })
          r += 2
        } else {
          cells.push({
            photoIds: [run[r].id],
            durationMs
          })
          r += 1
        }
      }
    }
  }

  return cells
}

/**
 * 依據規格書 §2.3 計算展示格左下角的三行文字
 * 1. 第一行（粗體大字）：站點顯示名稱（customName 優先於 autoName）
 * 2. 第二行（中字）：該展示格第一張照片的當地日期（YYYY年M月D日）
 * 3. 第三行（小字，可省略）：
 *    - 單張格：有照片備註顯示照片備註；否則有站點備註顯示站點備註；都沒有則不顯示
 *    - 拼圖格：取格內第一張有照片備註的照片；皆無則用站點備註
 */
export function resolveDisplayCellOverlayText(
  cell: DisplayCell,
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
