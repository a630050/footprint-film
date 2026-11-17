import type { Journey } from '../types/journey'

/** 最多保留幾步可復原 */
export const MAX_HISTORY_STEPS = 50

/** 同一個欄位連續輸入時，這段時間內的變更合併成一步（例如打字改站點名稱） */
export const HISTORY_COALESCE_MS = 1500

/** 旅程編輯紀錄：past 是可復原的舊版本（最後一個是最近一步），future 是可重做的版本 */
export interface JourneyHistory {
  past: Journey[]
  future: Journey[]
  lastKey: string | null
  lastAt: number
}

export function createEmptyHistory(): JourneyHistory {
  return { past: [], future: [], lastKey: null, lastAt: 0 }
}

/**
 * 記錄一次編輯：把編輯前的旅程放進 past，並清空 future。
 * 同一個 key 在 HISTORY_COALESCE_MS 內連續變更時只記第一次（打字不會一個字一步）
 * @param before 編輯前的旅程
 * @param key 可合併的編輯種類（例如 `rename:站點ID`）；null 表示不合併
 */
export function recordHistory(history: JourneyHistory, before: Journey, key: string | null, now: number): JourneyHistory {
  if (key !== null && key === history.lastKey && now - history.lastAt < HISTORY_COALESCE_MS) {
    return { ...history, future: [], lastAt: now }
  }
  const past = [...history.past, before]
  if (past.length > MAX_HISTORY_STEPS) past.splice(0, past.length - MAX_HISTORY_STEPS)
  return { past, future: [], lastKey: key, lastAt: now }
}

/** 復原：回到上一個版本；沒有可復原的步驟時回傳 null */
export function undoHistory(history: JourneyHistory, current: Journey): { history: JourneyHistory; journey: Journey } | null {
  if (history.past.length === 0) return null
  const past = history.past.slice(0, -1)
  const journey = history.past[history.past.length - 1]
  return { journey, history: { past, future: [current, ...history.future], lastKey: null, lastAt: 0 } }
}

/** 重做：回到復原前的版本；沒有可重做的步驟時回傳 null */
export function redoHistory(history: JourneyHistory, current: Journey): { history: JourneyHistory; journey: Journey } | null {
  if (history.future.length === 0) return null
  const [journey, ...future] = history.future
  return { journey, history: { past: [...history.past, current], future, lastKey: null, lastAt: 0 } }
}
