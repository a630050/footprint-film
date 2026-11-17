import { describe, expect, it } from 'vitest'
import { DEFAULT_JOURNEY_SETTINGS } from '../src/constants/video-config'
import { computeMotionTransform, computeTileRects, gridRects } from '../src/domain/page-geometry'
import {
  buildAutoPages,
  buildStationCells,
  computePageDurationMs,
  getAvailableLayouts,
  movePhotoInPages,
  resolveStationPages,
  togglePageBreak
} from '../src/domain/pages'
import type { Photo, Station } from '../src/types/journey'

function photo(id: string, t?: number, portrait = false): Photo {
  return {
    id,
    fileName: `${id}.jpg`,
    imageBlob: new Blob(['x']),
    width: portrait ? 1080 : 1920,
    height: portrait ? 1920 : 1080,
    captureTimeUtc: t,
    localDate: '2026-11-15',
    coordinates: { latitude: 25, longitude: 121 },
    locationSource: 'exif',
    included: true
  }
}

const MIN = 60_000

describe('pages: 連拍門檻自動成頁', () => {
  it('相隔 1 分鐘內的連續照片合成一頁，超過門檻就分開', () => {
    const photos = [photo('a', 0), photo('b', 20_000), photo('c', 50_000), photo('d', 50_000 + 5 * MIN), photo('e', 50_000 + 5 * MIN + 30_000)]
    const pages = buildAutoPages(photos, { ...DEFAULT_JOURNEY_SETTINGS, autoCollage: false })
    expect(pages.map((p) => p.photoIds)).toEqual([['a', 'b', 'c'], ['d', 'e']])
  })

  it('門檻設為 0 時關閉連拍分組', () => {
    const photos = [photo('a', 0), photo('b', 1000)]
    const pages = buildAutoPages(photos, { ...DEFAULT_JOURNEY_SETTINGS, autoCollage: false, burstThresholdSec: 0 })
    expect(pages.map((p) => p.photoIds)).toEqual([['a'], ['b']])
  })

  it('超過 12 張的連拍切成多頁', () => {
    const photos = Array.from({ length: 15 }, (_, i) => photo(`p${i}`, i * 1000))
    const pages = buildAutoPages(photos, DEFAULT_JOURNEY_SETTINGS)
    expect(pages.map((p) => p.photoIds.length)).toEqual([12, 3])
  })
})

describe('pages: 分隔線與拖曳', () => {
  const base = [
    { id: 'p1', photoIds: ['a', 'b', 'c'] },
    { id: 'p2', photoIds: ['d'] }
  ]

  it('同一頁中間點擊 → 切成兩頁；分隔線上點擊 → 合併', () => {
    const split = togglePageBreak(base, 'a', 'b')
    expect(split.map((p) => p.photoIds)).toEqual([['a'], ['b', 'c'], ['d']])
    const merged = togglePageBreak(base, 'c', 'd')
    expect(merged.map((p) => p.photoIds)).toEqual([['a', 'b', 'c', 'd']])
    expect(merged[0].id).toBe('p1')
  })

  it('拖曳照片到另一頁的照片後面，空頁自動移除', () => {
    const moved = movePhotoInPages(base, 'd', 'a', true)
    expect(moved.map((p) => p.photoIds)).toEqual([['a', 'd', 'b', 'c']])
  })

  it('手動分頁會略過已不在站點的照片，新移入的照片自成一頁', () => {
    const station: Station = {
      id: 's',
      photoIds: ['a', 'c', 'x'],
      center: { latitude: 25, longitude: 121 },
      autoName: 'S',
      pages: base
    }
    const map = Object.fromEntries(['a', 'c', 'x'].map((id) => [id, photo(id)]))
    expect(resolveStationPages(station, map, DEFAULT_JOURNEY_SETTINGS).map((p) => p.photoIds)).toEqual([['a', 'c'], ['x']])
  })
})

describe('pages: 樣式與時長', () => {
  it('依張數提供可用樣式，超過 9 張只能輪動', () => {
    expect(getAvailableLayouts(1)).toEqual(['single'])
    expect(getAvailableLayouts(4)).toContain('grid')
    expect(getAvailableLayouts(7)).toEqual(['grid', 'polaroid', 'reveal', 'burst'])
    expect(getAvailableLayouts(12)).toEqual(['burst'])
  })

  it('連拍輪動每張約 0.5 秒，介於每頁秒數的 1～2 倍', () => {
    expect(computePageDurationMs('burst', 3, 2)).toBe(2000)
    expect(computePageDurationMs('burst', 6, 2)).toBe(3000)
    expect(computePageDurationMs('burst', 12, 2)).toBe(4000)
  })

  it('隨機結果固定：同樣的照片每次都得到同樣的樣式與運鏡', () => {
    const photos = [photo('a', 0, true), photo('b', 10 * MIN, true), photo('c', 20 * MIN, true)]
    const station: Station = { id: 's', photoIds: ['a', 'b', 'c'], center: { latitude: 25, longitude: 121 }, autoName: 'S' }
    const map = Object.fromEntries(photos.map((p) => [p.id, p]))
    const first = buildStationCells(station, map, DEFAULT_JOURNEY_SETTINGS)
    const second = buildStationCells(station, map, DEFAULT_JOURNEY_SETTINGS)
    expect(first).toEqual(second)
    expect(first).toHaveLength(1)
    expect(getAvailableLayouts(3)).toContain(first[0].layout)
  })

  it('手動指定的樣式優先，取消入選使張數不符時改回自動', () => {
    const photos = [photo('a'), photo('b')]
    const map = Object.fromEntries(photos.map((p) => [p.id, p]))
    const station: Station = {
      id: 's',
      photoIds: ['a', 'b'],
      center: { latitude: 25, longitude: 121 },
      autoName: 'S',
      pages: [{ id: 'p', photoIds: ['a', 'b'], layout: 'rows', motion: { zoom: 'out', direction: 'w' } }]
    }
    const cells = buildStationCells(station, map, DEFAULT_JOURNEY_SETTINGS)
    expect(cells[0].layout).toBe('rows')
    expect(cells[0].motion).toEqual({ zoom: 'out', direction: 'w' })

    map.b = { ...map.b, included: false }
    const single = buildStationCells(station, map, DEFAULT_JOURNEY_SETTINGS)
    expect(single[0].layout).toBe('single')
    expect(single[0].photoIds).toEqual(['a'])
  })
})

describe('page-geometry: 版面與運鏡', () => {
  it('宮格最後一列不滿時拉寬填滿，所有格子都在畫面內', () => {
    const rects = gridRects(5, 1920, 1080, 6)
    expect(rects).toHaveLength(5)
    const last = rects.slice(3)
    expect(last[0].w).toBeGreaterThan(rects[0].w)
    for (const r of rects) {
      expect(r.x + r.w).toBeLessThanOrEqual(1920 + 1e-6)
      expect(r.y + r.h).toBeLessThanOrEqual(1080 + 1e-6)
    }
  })

  it('左大右小：大圖佔 60% 寬', () => {
    const rects = computeTileRects('feature-left', 3, 1920, 1080, 0)
    expect(rects[0].w).toBeCloseTo(1152, 3)
    expect(rects[1].x).toBeCloseTo(1152, 3)
  })

  it('運鏡位移永遠不超過放大後多出的邊界（不露出空白）', () => {
    const zooms = ['in', 'out', 'none'] as const
    const dirs = ['none', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const
    for (const zoom of zooms) {
      for (const direction of dirs) {
        for (let i = 0; i <= 20; i++) {
          const t = computeMotionTransform({ zoom, direction }, i / 20)
          const slack = (1 - 1 / t.scale) / 2
          expect(Math.abs(t.centerOffsetX)).toBeLessThanOrEqual(slack + 1e-9)
          expect(Math.abs(t.centerOffsetY)).toBeLessThanOrEqual(slack + 1e-9)
          expect(t.scale).toBeGreaterThanOrEqual(1)
        }
      }
    }
  })

  it('漸進從原尺寸放大、漸遠從放大縮回原尺寸', () => {
    expect(computeMotionTransform({ zoom: 'in', direction: 'none' }, 0).scale).toBe(1)
    expect(computeMotionTransform({ zoom: 'in', direction: 'none' }, 1).scale).toBeCloseTo(1.12, 6)
    expect(computeMotionTransform({ zoom: 'out', direction: 'none' }, 1).scale).toBe(1)
  })
})
