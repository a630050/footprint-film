/**
 * 拍攝時間與當地日期解析工具
 * NOTE: 依據 §4.1 規則：
 * 1. 有 OffsetTimeOriginal → 用它把當地時間換算成 UTC
 * 2. 否則有 GPS 時間戳（本身即 UTC）→ 用它
 * 3. 都沒有 → 以表面當地時間視同 UTC（跨時區旅程可能排序偏差）
 * 畫面顯示一律用拍攝地的當地日期（取 EXIF 原始當地時間的日期部分）
 */

export interface ExifTimeInput {
  /** EXIF DateTimeOriginal，格式如 "2026:11:15 14:30:00" 或 ISO 字串，或 Date 物件 */
  dateTimeOriginal?: string | Date
  /** EXIF OffsetTimeOriginal，格式如 "+08:00" 或 "-05:00" */
  offsetTimeOriginal?: string
  /** EXIF GPSDateStamp，格式如 "2026:11:15" 或 "2026-11-15" */
  gpsDateStamp?: string
  /** EXIF GPSTimeStamp，格式如 [6, 30, 0] 或 "06:30:00" */
  gpsTimeStamp?: [number, number, number] | string
}

export interface ParsedCaptureTime {
  /** 拍攝時間（UTC 毫秒時間戳），用於排序照片與分站 */
  captureTimeUtc?: number
  /** 拍攝地當地日期 'YYYY-MM-DD'，用於畫面顯示 */
  localDate?: string
}

/**
 * 將 EXIF 原始日期字串或 Date 解析為年、月、日、時、分、秒
 * @param raw EXIF DateTimeOriginal 原始值
 * @returns 解析後的時間部分，若無法解析則回傳 undefined
 */
function parseExifDateTimeParts(raw: string | Date): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
} | undefined {
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return undefined
    // NOTE: exifr 有時會將 DateTimeOriginal 解析為執行環境本地時區的 Date，
    // 取 getFullYear/getMonth/getDate 可還原表面數值
    return {
      year: raw.getFullYear(),
      month: raw.getMonth() + 1,
      day: raw.getDate(),
      hour: raw.getHours(),
      minute: raw.getMinutes(),
      second: raw.getSeconds()
    }
  }

  const trimmed = raw.trim()
  // 匹配 "YYYY:MM:DD HH:mm:ss" 或 "YYYY-MM-DD HH:mm:ss" 或 ISO 格式
  const match = /^(\d{4})[:\-](\d{2})[:\-](\d{2})[T\s](\d{2}):(\d{2}):(\d{2})/.exec(trimmed)
  if (!match) return undefined

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])

  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined
  return { year, month, day, hour, minute, second }
}

/**
 * 解析時區偏移字串（如 "+08:00", "-05:30", "+00:00", "Z"）為分鐘數
 * @param offset 時區偏移字串
 * @returns 偏移分鐘數（東時區為正，西時區為負）
 */
export function parseTimezoneOffsetMinutes(offset?: string): number | undefined {
  if (!offset) return undefined
  const trimmed = offset.trim()
  if (trimmed === 'Z' || trimmed === 'z') return 0

  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(trimmed)
  if (!match) return undefined

  const sign = match[1] === '+' ? 1 : -1
  const hours = Number(match[2])
  const minutes = Number(match[3])
  if (hours > 14 || minutes > 59) return undefined

  return sign * (hours * 60 + minutes)
}

/**
 * 解析 GPS 日期與時間戳為 UTC 毫秒數
 * @param gpsDateStamp GPSDateStamp (如 "2026:11:15")
 * @param gpsTimeStamp GPSTimeStamp (如 [6, 30, 0] 或 "06:30:00")
 * @returns UTC 毫秒時間戳與對應日期字串
 */
function parseGpsTimestamp(
  gpsDateStamp?: string,
  gpsTimeStamp?: [number, number, number] | string
): { utcMs: number; dateStr: string } | undefined {
  if (!gpsDateStamp || !gpsTimeStamp) return undefined

  const dateMatch = /^(\d{4})[:\-](\d{2})[:\-](\d{2})$/.exec(gpsDateStamp.trim())
  if (!dateMatch) return undefined

  const year = Number(dateMatch[1])
  const month = Number(dateMatch[2])
  const day = Number(dateMatch[3])

  let hour = 0
  let minute = 0
  let second = 0

  if (Array.isArray(gpsTimeStamp)) {
    if (gpsTimeStamp.length < 3) return undefined
    hour = Number(gpsTimeStamp[0])
    minute = Number(gpsTimeStamp[1])
    second = Math.floor(Number(gpsTimeStamp[2]))
  } else if (typeof gpsTimeStamp === 'string') {
    const timeMatch = /^(\d{1,2}):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(gpsTimeStamp.trim())
    if (!timeMatch) return undefined
    hour = Number(timeMatch[1])
    minute = Number(timeMatch[2])
    second = Math.floor(Number(timeMatch[3]))
  } else {
    return undefined
  }

  if ([year, month, day, hour, minute, second].some(isNaN)) return undefined

  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second)
  const dateStr = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return { utcMs, dateStr }
}

/**
 * 依據規格書 §4.1 換算拍攝時間（UTC）與當地日期
 * @param input EXIF 時間欄位
 * @returns 拍攝時間（UTC ms）與當地日期（YYYY-MM-DD）
 */
export function parseCaptureTime(input: ExifTimeInput): ParsedCaptureTime {
  const localParts = input.dateTimeOriginal
    ? parseExifDateTimeParts(input.dateTimeOriginal)
    : undefined

  const localDate = localParts
    ? `${String(localParts.year).padStart(4, '0')}-${String(localParts.month).padStart(2, '0')}-${String(localParts.day).padStart(2, '0')}`
    : undefined

  // 1. 有 DateTimeOriginal 且有 OffsetTimeOriginal → 用時區偏移換算為真實 UTC
  if (localParts) {
    const offsetMinutes = parseTimezoneOffsetMinutes(input.offsetTimeOriginal)
    const nominalUtcMs = Date.UTC(
      localParts.year,
      localParts.month - 1,
      localParts.day,
      localParts.hour,
      localParts.minute,
      localParts.second
    )

    if (offsetMinutes !== undefined) {
      return {
        captureTimeUtc: nominalUtcMs - offsetMinutes * 60_000,
        localDate
      }
    }

    // 2. 無 OffsetTimeOriginal，但有 GPS 時間戳（本身即 UTC）→ 用 GPS 時間戳作為 UTC，保留 DateTimeOriginal 的當地日期
    const gpsParsed = parseGpsTimestamp(input.gpsDateStamp, input.gpsTimeStamp)
    if (gpsParsed) {
      return {
        captureTimeUtc: gpsParsed.utcMs,
        localDate
      }
    }

    // 3. 都沒有 → 以表面當地時間視同 UTC
    return {
      captureTimeUtc: nominalUtcMs,
      localDate
    }
  }

  // 若無 DateTimeOriginal，但有 GPS 時間戳
  const gpsParsed = parseGpsTimestamp(input.gpsDateStamp, input.gpsTimeStamp)
  if (gpsParsed) {
    return {
      captureTimeUtc: gpsParsed.utcMs,
      localDate: gpsParsed.dateStr
    }
  }

  return {}
}

/**
 * 將 'YYYY-MM-DD' 格式化為站點段左下角顯示的繁體中文日期格式 'YYYY年M月D日'
 * @param localDate 當地日期字串 'YYYY-MM-DD'
 * @returns 格式化字串，如 '2026年11月15日'
 */
export function formatLocalDateDisplay(localDate?: string): string {
  if (!localDate) return ''
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate.trim())
  if (!match) return localDate
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  return `${year}年${month}月${day}日`
}

/**
 * 將站點內的照片日期範圍格式化為卡片顯示格式（如 '11/15 – 11/17' 或單日 '11/15'）
 * @param localDates 照片的當地日期陣列
 * @returns 日期範圍字串
 */
export function formatDateRangeShort(localDates: (string | undefined)[]): string {
  const valid = localDates.filter((d): d is string => Boolean(d)).sort()
  if (valid.length === 0) return ''

  const formatMonthDay = (iso: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
    if (!match) return iso
    return `${Number(match[2])}/${Number(match[3])}`
  }

  const first = valid[0]
  const last = valid[valid.length - 1]
  if (first === last) return formatMonthDay(first)
  return `${formatMonthDay(first)} – ${formatMonthDay(last)}`
}

/**
 * 將整個旅程的起訖日期格式化為片頭／片尾顯示字串（如 '2026.11.15 – 2026.11.22'）
 * @param localDates 旅程中所有入選照片的當地日期
 * @returns 旅程日期範圍字串
 */
export function formatJourneyDateRange(localDates: (string | undefined)[]): string {
  const valid = localDates.filter((d): d is string => Boolean(d)).sort()
  if (valid.length === 0) return ''

  const toDot = (iso: string) => iso.replace(/-/g, '.')
  const first = valid[0]
  const last = valid[valid.length - 1]
  if (first === last) return toDot(first)
  return `${toDot(first)} – ${toDot(last)}`
}
