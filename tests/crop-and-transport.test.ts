import { describe, expect, it } from 'vitest'
import {
  clampCropView,
  cropExceedsImage,
  cropToView,
  defaultCropView,
  fitCropToAspect,
  fitScales,
  MAX_CROP_ZOOM,
  viewToCrop
} from '../src/domain/photo-crop'
import { resolveLegRouteKind } from '../src/domain/timeline-builder'

const landscapePhoto = { width: 1920, height: 1280 }
const portraitPhoto = { width: 1080, height: 1920 }
const frame = { width: 640, height: 360 } // 16:9 取景框

describe('photo-crop: 取景範圍', () => {
  it('預設取景與影片自動取景一致：同方向填滿、不同方向完整顯示', () => {
    expect(defaultCropView(landscapePhoto, frame).scale).toBeCloseTo(fitScales(landscapePhoto, frame).cover, 6)
    expect(defaultCropView(portraitPhoto, frame).scale).toBeCloseTo(fitScales(portraitPhoto, frame).contain, 6)
  })

  it('縮放限制在「完整顯示」到「填滿的 5 倍」之間，平移不會拖出照片', () => {
    const { contain, cover } = fitScales(landscapePhoto, frame)
    expect(clampCropView({ cx: 0.5, cy: 0.5, scale: contain / 10 }, landscapePhoto, frame).scale).toBeCloseTo(contain, 6)
    expect(clampCropView({ cx: 0.5, cy: 0.5, scale: cover * 100 }, landscapePhoto, frame).scale).toBeCloseTo(cover * MAX_CROP_ZOOM, 6)

    const v = clampCropView({ cx: 5, cy: -5, scale: cover * 2 }, landscapePhoto, frame)
    const crop = viewToCrop(v, landscapePhoto, frame)
    expect(crop.x + crop.w).toBeLessThanOrEqual(1 + 1e-9)
    expect(crop.y).toBeGreaterThanOrEqual(-1e-9)
  })

  it('取景狀態與儲存範圍可以互相轉換（重新開啟時畫面不變）', () => {
    const v = clampCropView({ cx: 0.3, cy: 0.6, scale: fitScales(landscapePhoto, frame).cover * 1.8 }, landscapePhoto, frame)
    const back = cropToView(viewToCrop(v, landscapePhoto, frame), landscapePhoto, frame)
    expect(back.cx).toBeCloseTo(v.cx, 6)
    expect(back.cy).toBeCloseTo(v.cy, 6)
    expect(back.scale).toBeCloseTo(v.scale, 6)
  })

  it('畫進不同比例的格子時，以取景中心為準裁成格子比例', () => {
    const crop = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }
    const rect = fitCropToAspect(crop, landscapePhoto, 9 / 16)
    expect(rect.w / rect.h).toBeCloseTo(9 / 16, 6)
    expect(rect.x + rect.w / 2).toBeCloseTo(960, 6)
    expect(rect.y + rect.h / 2).toBeCloseTo(640, 6)
  })

  it('直拍照片完整顯示時取景超出照片，需要模糊背景', () => {
    const v = defaultCropView(portraitPhoto, frame)
    const rect = fitCropToAspect(viewToCrop(v, portraitPhoto, frame), portraitPhoto, 16 / 9)
    expect(cropExceedsImage(rect, portraitPhoto)).toBe(true)
  })
})

describe('timeline-builder: 站點之間的交通方式', () => {
  const taipei = { center: { latitude: 25.033, longitude: 121.5654 } }
  const kaohsiung = { center: { latitude: 22.6273, longitude: 120.3014 } } // 約 300 km

  it('未指定時依長途門檻判斷；手動指定時優先（長途高鐵仍是陸路）', () => {
    expect(resolveLegRouteKind(taipei, kaohsiung, 100)).toBe('flight')
    expect(resolveLegRouteKind(taipei, { ...kaohsiung, arrivalRouteKind: 'ground' }, 100)).toBe('ground')
    expect(resolveLegRouteKind(taipei, { center: { latitude: 25.0, longitude: 121.3 }, arrivalRouteKind: 'flight' }, 100)).toBe('flight')
  })
})
