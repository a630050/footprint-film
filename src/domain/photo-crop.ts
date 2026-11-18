import type { PhotoCrop } from '../types/journey'

/** 最多放大到「剛好填滿畫面」的幾倍 */
export const MAX_CROP_ZOOM = 5

/**
 * 取景狀態：以照片像素為單位的中心點（cx、cy 為 0～1 比例）與縮放（畫面像素 / 照片像素）
 */
export interface CropView {
  cx: number
  cy: number
  scale: number
}

interface Size {
  width: number
  height: number
}

/** 完整顯示照片（contain）與填滿畫面（cover）兩種縮放 */
export function fitScales(image: Size, frame: Size): { contain: number; cover: number } {
  const sx = frame.width / image.width
  const sy = frame.height / image.height
  return { contain: Math.min(sx, sy), cover: Math.max(sx, sy) }
}

/**
 * 未裁切時的預設取景，與影片的自動取景一致：
 * 照片與畫面方向相同 → 填滿；方向不同（例如橫式影片中的直拍）→ 完整顯示、兩側模糊背景
 */
export function defaultCropView(image: Size, frame: Size): CropView {
  const { contain, cover } = fitScales(image, frame)
  const sameOrientation = image.width >= image.height === frame.width >= frame.height
  return { cx: 0.5, cy: 0.5, scale: sameOrientation ? cover : contain }
}

/**
 * 限制縮放範圍（完整顯示 ～ 填滿的 5 倍），並限制平移：
 * 照片比畫面大的方向不能拖出照片邊界；比畫面小的方向固定置中
 */
export function clampCropView(view: CropView, image: Size, frame: Size): CropView {
  const { contain, cover } = fitScales(image, frame)
  const scale = Math.max(contain, Math.min(cover * MAX_CROP_ZOOM, view.scale))
  const visibleW = frame.width / scale / image.width
  const visibleH = frame.height / scale / image.height
  const clampAxis = (c: number, visible: number) =>
    visible >= 1 ? 0.5 : Math.max(visible / 2, Math.min(1 - visible / 2, c))
  return { cx: clampAxis(view.cx, visibleW), cy: clampAxis(view.cy, visibleH), scale }
}

/** 取景狀態 → 儲存用的比例範圍 */
export function viewToCrop(view: CropView, image: Size, frame: Size): PhotoCrop {
  const w = frame.width / view.scale / image.width
  const h = frame.height / view.scale / image.height
  return { x: view.cx - w / 2, y: view.cy - h / 2, w, h }
}

/** 儲存的比例範圍 → 取景狀態（畫面比例改變時以 cover 方式套用） */
export function cropToView(crop: PhotoCrop, image: Size, frame: Size): CropView {
  const rect = fitCropToAspect(crop, image, frame.width / frame.height)
  return {
    cx: (rect.x + rect.w / 2) / image.width,
    cy: (rect.y + rect.h / 2) / image.height,
    scale: frame.width / rect.w
  }
}

/**
 * 把比例範圍換成照片像素範圍，並以中心為準裁成指定的長寬比（只縮不放，等同 cover）。
 * 用於把取景範圍畫進不同比例的格子（例如拼圖的直長格）
 */
export function fitCropToAspect(crop: PhotoCrop, image: Size, aspect: number): { x: number; y: number; w: number; h: number } {
  let w = crop.w * image.width
  let h = crop.h * image.height
  const cx = (crop.x + crop.w / 2) * image.width
  const cy = (crop.y + crop.h / 2) * image.height
  if (w / h > aspect) w = h * aspect
  else h = w / aspect
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}

/** 取景範圍是否超出照片（需要模糊背景補滿） */
export function cropExceedsImage(rect: { x: number; y: number; w: number; h: number }, image: Size): boolean {
  const eps = 0.5
  return rect.x < -eps || rect.y < -eps || rect.x + rect.w > image.width + eps || rect.y + rect.h > image.height + eps
}
