import { Loader2, ZoomIn, ZoomOut } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { decodeAndDownscaleWithHeicFallback } from '../services/photo-reader'

/** 裁切框（圓形）在畫面上的直徑，CSS 像素 */
const CROP_VIEW_SIZE = 280
/** 輸出的大頭照尺寸（正方形，繪製時再裁成圓形） */
const AVATAR_OUTPUT_SIZE = 320
const MAX_ZOOM = 5

interface AvatarCropperProps {
  file: File
  onCancel: () => void
  onSave: (avatar: Blob) => void
}

interface CropState {
  zoom: number // 1 = 照片短邊剛好填滿圓框
  offsetX: number // 照片中心相對圓框中心的位移（CSS 像素）
  offsetY: number
}

/** 讓照片永遠蓋滿整個圓框：限制位移量 */
function clampCrop(state: CropState, image: ImageBitmap): CropState {
  const zoom = Math.max(1, Math.min(MAX_ZOOM, state.zoom))
  const scale = (CROP_VIEW_SIZE / Math.min(image.width, image.height)) * zoom
  const maxX = Math.max(0, (image.width * scale - CROP_VIEW_SIZE) / 2)
  const maxY = Math.max(0, (image.height * scale - CROP_VIEW_SIZE) / 2)
  return {
    zoom,
    offsetX: Math.max(-maxX, Math.min(maxX, state.offsetX)),
    offsetY: Math.max(-maxY, Math.min(maxY, state.offsetY))
  }
}

/** 依裁切狀態把照片畫到正方形畫布上（預覽與輸出共用） */
function drawCrop(ctx: CanvasRenderingContext2D, size: number, image: ImageBitmap, crop: CropState): void {
  const ratio = size / CROP_VIEW_SIZE
  const scale = (CROP_VIEW_SIZE / Math.min(image.width, image.height)) * crop.zoom * ratio
  const drawW = image.width * scale
  const drawH = image.height * scale
  ctx.clearRect(0, 0, size, size)
  ctx.drawImage(
    image,
    size / 2 + crop.offsetX * ratio - drawW / 2,
    size / 2 + crop.offsetY * ratio - drawH / 2,
    drawW,
    drawH
  )
}

/**
 * 大頭照裁切對話框：拖曳移動、滑桿／滾輪／雙指縮放，存檔後輸出 320×320 JPEG
 */
export function AvatarCropper({ file, onCancel, onSave }: AvatarCropperProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [image, setImage] = useState<ImageBitmap | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [crop, setCrop] = useState<CropState>({ zoom: 1, offsetX: 0, offsetY: 0 })
  const [isSaving, setIsSaving] = useState(false)

  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const gestureRef = useRef<{ crop: CropState; distance: number; centerX: number; centerY: number } | null>(null)

  // 讀取照片（支援 HEIC）
  useEffect(() => {
    let cancelled = false
    let loaded: ImageBitmap | null = null
    void (async () => {
      try {
        const { imageBlob } = await decodeAndDownscaleWithHeicFallback(file)
        const bmp = await createImageBitmap(imageBlob)
        if (cancelled) {
          bmp.close()
          return
        }
        loaded = bmp
        setImage(bmp)
      } catch {
        if (!cancelled) setError('無法讀取這張照片，請換一張試試。')
      }
    })()
    return () => {
      cancelled = true
      loaded?.close()
    }
  }, [file])

  // 重畫預覽
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !image) return
    const dpr = Math.min(3, window.devicePixelRatio || 1)
    const size = Math.round(CROP_VIEW_SIZE * dpr)
    if (canvas.width !== size) {
      canvas.width = size
      canvas.height = size
    }
    const ctx = canvas.getContext('2d')
    if (ctx) drawCrop(ctx, size, image, crop)
  }, [image, crop])

  const updateCrop = (next: CropState) => {
    if (image) setCrop(clampCrop(next, image))
  }

  /** 以圓框內某一點為支點縮放，讓手指／游標下的位置保持不動 */
  const zoomAround = (base: CropState, nextZoom: number, pivotX: number, pivotY: number) => {
    const clampedZoom = Math.max(1, Math.min(MAX_ZOOM, nextZoom))
    const factor = clampedZoom / base.zoom
    updateCrop({
      zoom: clampedZoom,
      offsetX: pivotX - (pivotX - base.offsetX) * factor,
      offsetY: pivotY - (pivotY - base.offsetY) * factor
    })
  }

  const localPoint = (clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    const ratio = CROP_VIEW_SIZE / rect.width
    return {
      x: (clientX - rect.left) * ratio - CROP_VIEW_SIZE / 2,
      y: (clientY - rect.top) * ratio - CROP_VIEW_SIZE / 2
    }
  }

  const startGesture = () => {
    const pts = [...pointersRef.current.values()]
    if (pts.length === 0) {
      gestureRef.current = null
      return
    }
    const centerX = pts.reduce((sum, p) => sum + p.x, 0) / pts.length
    const centerY = pts.reduce((sum, p) => sum + p.y, 0) / pts.length
    const distance = pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0
    gestureRef.current = { crop, distance, centerX, centerY }
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    pointersRef.current.set(e.pointerId, localPoint(e.clientX, e.clientY))
    startGesture()
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointersRef.current.has(e.pointerId) || !gestureRef.current) return
    pointersRef.current.set(e.pointerId, localPoint(e.clientX, e.clientY))
    const gesture = gestureRef.current
    const pts = [...pointersRef.current.values()]
    const centerX = pts.reduce((sum, p) => sum + p.x, 0) / pts.length
    const centerY = pts.reduce((sum, p) => sum + p.y, 0) / pts.length
    const moved: CropState = {
      ...gesture.crop,
      offsetX: gesture.crop.offsetX + (centerX - gesture.centerX),
      offsetY: gesture.crop.offsetY + (centerY - gesture.centerY)
    }
    if (pts.length >= 2 && gesture.distance > 0) {
      const distance = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      zoomAround(moved, gesture.crop.zoom * (distance / gesture.distance), centerX, centerY)
    } else {
      updateCrop(moved)
    }
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.delete(e.pointerId)
    startGesture()
  }

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const pivot = localPoint(e.clientX, e.clientY)
    zoomAround(crop, crop.zoom * Math.exp(-e.deltaY * 0.0015), pivot.x, pivot.y)
  }

  const handleSave = () => {
    if (!image) return
    setIsSaving(true)
    const out = document.createElement('canvas')
    out.width = AVATAR_OUTPUT_SIZE
    out.height = AVATAR_OUTPUT_SIZE
    const ctx = out.getContext('2d')
    if (!ctx) {
      setIsSaving(false)
      return
    }
    ctx.fillStyle = '#FFFFFF'
    ctx.fillRect(0, 0, AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE)
    drawCrop(ctx, AVATAR_OUTPUT_SIZE, image, crop)
    out.toBlob(
      (blob) => {
        setIsSaving(false)
        if (blob) onSave(blob)
        else setError('存檔失敗，請再試一次。')
      },
      'image/jpeg',
      0.9
    )
  }

  // Esc 關閉
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="裁切大頭照"
    >
      <div className="w-full max-w-sm space-y-4 rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
        <div>
          <h2 className="text-base font-bold text-white">裁切大頭照</h2>
          <p className="mt-1 text-xs text-slate-400">拖曳移動照片位置，用滑桿、滾輪或雙指縮放，讓臉部落在圓框中間。</p>
        </div>

        <div className="relative mx-auto aspect-square w-full max-w-[280px] overflow-hidden rounded-xl bg-slate-950">
          {image ? (
            <>
              <canvas
                ref={canvasRef}
                className="absolute inset-0 h-full w-full cursor-grab touch-none active:cursor-grabbing"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                onWheel={handleWheel}
              />
              {/* 圓框外變暗，只有圓框內是最後的大頭照 */}
              <div className="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_9999px_rgba(2,6,23,0.6)] ring-2 ring-white/90" />
            </>
          ) : (
            <div className="flex h-full items-center justify-center gap-2 text-xs text-slate-300">
              {error ? (
                <span className="px-4 text-center text-rose-300">{error}</span>
              ) : (
                <>
                  <Loader2 className="h-4 w-4 animate-spin text-amber-400" />
                  <span>正在讀取照片…</span>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          <ZoomOut className="h-4 w-4 shrink-0 text-slate-400" />
          <input
            type="range"
            aria-label="縮放"
            min={1}
            max={MAX_ZOOM}
            step={0.01}
            value={crop.zoom}
            disabled={!image}
            onChange={(e) => zoomAround(crop, Number(e.target.value), 0, 0)}
            className="flex-1 accent-amber-500"
          />
          <ZoomIn className="h-4 w-4 shrink-0 text-slate-400" />
        </div>

        <div className="flex justify-end gap-2 text-sm">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 font-medium text-slate-300 transition hover:bg-slate-700"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!image || isSaving}
            className="rounded-xl bg-amber-500 px-4 py-2 font-bold text-slate-950 transition hover:bg-amber-400 disabled:opacity-40"
          >
            存檔
          </button>
        </div>
      </div>
    </div>
  )
}
