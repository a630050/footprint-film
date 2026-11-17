import { describe, expect, it } from 'vitest'
import { DEFAULT_JOURNEY_SETTINGS } from '../src/constants/video-config'
import {
  createEmptyHistory,
  HISTORY_COALESCE_MS,
  MAX_HISTORY_STEPS,
  recordHistory,
  redoHistory,
  undoHistory
} from '../src/store/history'
import type { Journey } from '../src/types/journey'

function journey(title: string): Journey {
  return {
    photos: {},
    stations: [],
    unassignedPhotoIds: [],
    title,
    isTitleCustomized: true,
    hasManualStationEdits: false,
    settings: DEFAULT_JOURNEY_SETTINGS
  }
}

describe('history: 復原與重做', () => {
  it('復原回到上一步，重做回到復原前', () => {
    const a = journey('A')
    const b = journey('B')
    const c = journey('C')
    let h = createEmptyHistory()
    h = recordHistory(h, a, null, 0) // A → B
    h = recordHistory(h, b, null, 10) // B → C

    const u1 = undoHistory(h, c)!
    expect(u1.journey).toBe(b)
    const u2 = undoHistory(u1.history, u1.journey)!
    expect(u2.journey).toBe(a)
    expect(undoHistory(u2.history, u2.journey)).toBeNull()

    const r1 = redoHistory(u2.history, u2.journey)!
    expect(r1.journey).toBe(b)
    const r2 = redoHistory(r1.history, r1.journey)!
    expect(r2.journey).toBe(c)
    expect(redoHistory(r2.history, r2.journey)).toBeNull()
  })

  it('復原後再做新的編輯，就不能再重做', () => {
    let h = recordHistory(createEmptyHistory(), journey('A'), null, 0)
    const u = undoHistory(h, journey('B'))!
    h = recordHistory(u.history, u.journey, null, 100)
    expect(h.future).toHaveLength(0)
  })

  it('同一欄位連續輸入合併成一步，停頓超過門檻就分開', () => {
    const a = journey('A')
    let h = recordHistory(createEmptyHistory(), a, 'title', 0)
    h = recordHistory(h, journey('A1'), 'title', 500)
    h = recordHistory(h, journey('A12'), 'title', 1000)
    expect(h.past).toEqual([a])
    h = recordHistory(h, journey('A123'), 'title', 1000 + HISTORY_COALESCE_MS + 1)
    expect(h.past).toHaveLength(2)
    h = recordHistory(h, journey('X'), 'rename:s1', 1000 + HISTORY_COALESCE_MS + 2)
    expect(h.past).toHaveLength(3)
  })

  it('最多保留 50 步', () => {
    let h = createEmptyHistory()
    for (let i = 0; i < MAX_HISTORY_STEPS + 10; i++) h = recordHistory(h, journey(String(i)), null, i)
    expect(h.past).toHaveLength(MAX_HISTORY_STEPS)
    expect(h.past[0].title).toBe('10')
  })
})
