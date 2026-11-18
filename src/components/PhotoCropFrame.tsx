import { Crop, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  clampCropView,
  cropToView,
  type CropView,
  defaultCropView,
  fitScales,
  MAX_CROP_ZOOM,
  viewToCrop
} from '../domain/photo-crop'
import type { Photo, PhotoCrop } from '../types/journey'

/** 手勢結束多久後才寫入取景（滾輪連續轉動時只存最後一次） */
const COMMIT_DELAY_MS = 250

interface PhotoCropFrameProps {
  photo: Photo
  url: string | null
  /** 影片畫面比例（寬 / 高） */
  aspect: number
  onCommit: (crop: PhotoCrop | undefined) => void
}

/**
 * 放大檢視中的取景框：框的比例就是影片畫面比例，框內即影片中這張照片的樣子
 * - 拖曳平移、雙指或滾輪縮放（以手指／游標位置為中心）、滑桿縮放
 * - 縮小到比畫面小時，兩側以模糊背景補滿（與影片一致）
 * - 手勢結束後自動儲存；「自動取景」恢復預設
 */
export function PhotoCropFrame({ photo, url, aspect, onCommit }: PhotoCropFrameProps) {
  const areaRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [frame, setFrame] = useState({ width: 0, height: 0 })
  const image = { width: photo.width, height: photo.height }

  const [view, setView] = useState<CropView | null>(null)
  const viewRef = useRef<CropView | null>(null)
  viewRef.current = view
  const [isInteracting, setIsInteracting] = useState(false)

  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const gestureRef = useRef<{ view: CropView; distance: number; x: number; y: number } | null>(null)
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit

  // 依可用空間算出符合影片比例的取景框大小
  useLayoutEffect(() => {
    const area = areaRef.current
    if (!area) return
    const measure = () => {
      const w = area.clientWidth
      const h = area.clientHeight
      if (w <= 0 || h <= 0) return
      const width = Math.min(w, h * aspect)
      setFrame({ width, height: width / aspect })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(area)
    return () => ro.disconnect()
  }, [aspect])

  // 換照片或取景框大小改變時，依已存的取景（或預設）重新計算
  useEffect(() => {
    if (frame.width <= 0) return
    const base = photo.crop ? cropToView(photo.crop, image, frame) : defaultCropView(image, frame)
    setView(clampCropView(base, image, frame))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo.id, photo.crop, frame.width, frame.height])

  useEffect(
    () => () => {
      if (commitTimerRef.current) clearTimeout(commitTimerRef.current)
    },
    []
  )

  const scheduleCommit = () => {
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current)
    commitTimerRef.current = setTimeout(() => {
      const v = viewRef.current
      if (v && frame.width > 0) onCommitRef.current(viewToCrop(v, image, frame))
    }, COMMIT_DELAY_MS)
  }

  const apply = (next: CropView) => setView(clampCropView(next, image, frame))

  /** 以取景框內某點（相對框左上角的像素）為中心縮放 */
  const zoomAt = (base: CropView, nextScale: number, px: number, py: number) => {
    const clamped = clampCropView({ ...base, scale: nextScale }, image, frame).scale
    // 縮放前後，游標下的照片位置保持不變
    const imgX = base.cx * image.width + (px - frame.width / 2) / base.scale
    const imgY = base.cy * image.height + (py - frame.height / 2) / base.scale
    apply({
      scale: clamped,
      cx: (imgX - (px - frame.width / 2) / clamped) / image.width,
      cy: (imgY - (py - frame.height / 2) / clamped) / image.height
    })
  }

  const localPoint = (clientX: number, clientY: number) => {
    const rect = frameRef.current?.getBoundingClientRect()
    return rect ? { x: clientX - rect.left, y: clientY - rect.top } : { x: 0, y: 0 }
  }

  const startGesture = () => {
    const pts = [...pointersRef.current.values()]
    const v = viewRef.current
    if (pts.length === 0 || !v) {
      gestureRef.current = null
      return
    }
    const x = pts.reduce((s, p) => s + p.x, 0) / pts.length
    const y = pts.reduce((s, p) => s + p.y, 0) / pts.length
    const distance = pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0
    gestureRef.current = { view: v, distance, x, y }
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    pointersRef.current.set(e.pointerId, localPoint(e.clientX, e.clientY))
    setIsInteracting(true)
    startGesture()
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(e.pointerId) || !gestureRef.current) return
    pointersRef.current.set(e.pointerId, localPoint(e.clientX, e.clientY))
    const g = gestureRef.current
    const pts = [...pointersRef.current.values()]
    const x = pts.reduce((s, p) => s + p.x, 0) / pts.length
    const y = pts.reduce((s, p) => s + p.y, 0) / pts.length
    const moved: CropView = {
      ...g.view,
      cx: g.view.cx - (x - g.x) / g.view.scale / image.width,
      cy: g.view.cy - (y - g.y) / g.view.scale / image.height
    }
    if (pts.length >= 2 && g.distance > 0) {
      const distance = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      zoomAt(moved, g.view.scale * (distance / g.distance), x, y)
    } else {
      apply(moved)
    }
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(e.pointerId)
    startGesture()
    if (pointersRef.current.size === 0) {
      setIsInteracting(false)
      scheduleCommit()
    }
  }

  // 滾輪縮放需要阻止頁面捲動，因此用非被動的原生事件
  useEffect(() => {
    const el = frameRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const v = viewRef.current
      if (!v) return
      e.preventDefault()
      const p = localPoint(e.clientX, e.clientY)
      zoomAt(v, v.scale * Math.exp(-e.deltaY * 0.0015), p.x, p.y)
      scheduleCommit()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  const { contain, cover } = frame.width > 0 ? fitScales(image, frame) : { contain: 1, cover: 1 }
  const minLog = Math.log(contain)
  const maxLog = Math.log(cover * MAX_CROP_ZOOM)
  const sliderValue = view ? (Math.log(view.scale) - minLog) / Math.max(1e-6, maxLog - minLog) : 0
  const zoomPercent = view ? Math.round((view.scale / cover) * 100) : 100

  const left = view ? frame.width / 2 - view.cx * image.width * view.scale : 0
  const top = view ? frame.height / 2 - view.cy * image.height * view.scale : 0

  return (
    <div className="flex w-full flex-1 flex-col items-center gap-2">
      <div ref={areaRef} className="flex h-[46vh] w-full items-center justify-center sm:h-[52vh]">
        <div
          ref={frameRef}
          className="relative cursor-grab touch-none select-none overflow-hidden rounded-lg bg-black shadow-2xl ring-2 ring-white/80 active:cursor-grabbing"
          style={{ width: frame.width, height: frame.height }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          {url && view && (
            <>
              {/* 縮小到比畫面小時露出的模糊背景（與影片一致） */}
              <img src={url} alt="" aria-hidden="true" draggable={false} className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover opacity-80 blur-xl" />
              <img
                src={url}
                alt={photo.fileName}
                draggable={false}
                className="pointer-events-none absolute max-w-none"
                style={{ left, top, width: image.width * view.scale, height: image.height * view.scale }}
              />
            </>
          )}
          {/* 三分線輔助構圖（操作時顯示） */}
          {isInteracting && (
            <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3">
              {Array.from({ length: 9 }, (_, i) => (
                <div key={i} className="border border-white/25" />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex w-full max-w-md items-center gap-2 px-2 text-xs text-slate-300">
        <ZoomOut className="h-4 w-4 shrink-0 text-slate-400" />
        <input
          type="range"
          aria-label="縮放照片"
          min={0}
          max={1}
          step={0.001}
          value={sliderValue}
          onChange={(e) => {
            const v = viewRef.current
            if (!v) return
            const scale = Math.exp(minLog + Number(e.target.value) * (maxLog - minLog))
            zoomAt(v, scale, frame.width / 2, frame.height / 2)
            scheduleCommit()
          }}
          className="flex-1 accent-amber-500"
        />
        <ZoomIn className="h-4 w-4 shrink-0 text-slate-400" />
        <span className="w-12 text-right font-mono">{zoomPercent}%</span>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2 text-[11px] text-slate-400">
        <span className="inline-flex items-center gap-1">
          <Crop className="h-3.5 w-3.5" />
          {photo.crop ? '已自訂取景' : '自動取景'}・框內就是影片中的畫面，拖曳移動、雙指或滾輪縮放
        </span>
        {photo.crop && (
          <button
            type="button"
            onClick={() => onCommit(undefined)}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 font-medium text-slate-200 hover:bg-slate-700"
          >
            <RotateCcw className="h-3 w-3" />
            恢復自動取景
          </button>
        )}
      </div>
    </div>
  )
}
