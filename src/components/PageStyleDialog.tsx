import {
  ArrowDown,
  ArrowDownLeft,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  Images,
  Layers,
  type LucideIcon,
  Shuffle,
  Sparkles,
  X
} from 'lucide-react'
import { useEffect, useRef } from 'react'
import { getVideoDimensions } from '../constants/video-config'
import { computeTileRects } from '../domain/page-geometry'
import { computePageDurationMs, getAvailableLayouts, PAGE_LAYOUT_LABELS } from '../domain/pages'
import { FramePainter } from '../services/frame-painter'
import { useJourneyStore } from '../store/journey-store'
import type { MotionDirection, MotionZoom, PageLayout, PageMotion, Photo, StationPage } from '../types/journey'

const ZOOM_LABELS: Record<MotionZoom, string> = { in: '漸進', out: '漸遠', none: '不動' }

const DIRECTION_LABELS: Record<MotionDirection, string> = {
  none: '',
  n: '往上',
  ne: '往右上',
  e: '往右',
  se: '往右下',
  s: '往下',
  sw: '往左下',
  w: '往左',
  nw: '往左上'
}

/** 米字控制盤：3×3 排列，中間是縮放切換鈕 */
const PAD: (MotionDirection | 'center')[] = ['nw', 'n', 'ne', 'w', 'center', 'e', 'sw', 's', 'se']
const DIRECTION_ICONS: Record<Exclude<MotionDirection, 'none'>, LucideIcon> = {
  n: ArrowUp,
  ne: ArrowUpRight,
  e: ArrowRight,
  se: ArrowDownRight,
  s: ArrowDown,
  sw: ArrowDownLeft,
  w: ArrowLeft,
  nw: ArrowUpLeft
}

/** 運鏡的文字說明，例如「漸進 · 往右上」 */
export function describeMotion(motion: PageMotion): string {
  const parts: string[] = []
  if (motion.zoom !== 'none' || motion.direction === 'none') parts.push(ZOOM_LABELS[motion.zoom])
  if (motion.direction !== 'none') parts.push(DIRECTION_LABELS[motion.direction])
  return parts.join(' · ')
}

/** 拼接樣式的小圖示：一般版面直接畫出格子位置，特效版面用圖示 */
export function LayoutIcon({ layout, count, landscape }: { layout: PageLayout; count: number; landscape: boolean }) {
  const special: Partial<Record<PageLayout, LucideIcon>> = { polaroid: Images, burst: Layers, reveal: Sparkles }
  const Icon = special[layout]
  const w = landscape ? 32 : 20
  const h = landscape ? 20 : 32
  if (Icon) {
    return (
      <span className="flex items-center justify-center" style={{ width: 32, height: 32 }}>
        <Icon className="h-5 w-5" />
      </span>
    )
  }
  const rects = computeTileRects(layout === 'single' ? 'grid' : layout, layout === 'single' ? 1 : count, w, h, 1.5)
  return (
    <svg width={32} height={32} viewBox={`${(w - 32) / 2} ${(h - 32) / 2} 32 32`} aria-hidden="true">
      {rects.map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} rx={1.5} className="fill-current" opacity={i === 0 ? 0.95 : 0.6} />
      ))}
    </svg>
  )
}

interface PageStyleDialogProps {
  page: StationPage
  photos: Photo[] // 這一頁的入選照片
  /** 與影片相同規則決定的實際樣式與運鏡（自動時即隨機結果） */
  resolved: { layout: PageLayout; motion: PageMotion; seed: number }
  onChange: (patch: { layout?: PageLayout | undefined; motion?: PageMotion | undefined }) => void
  onClose: () => void
}

/**
 * 頁面設定視窗：左邊選拼接樣式、右邊用米字控制盤設定運鏡，上方即時預覽（手機上改為上下排列）
 */
export function PageStyleDialog({ page, photos, resolved, onChange, onClose }: PageStyleDialogProps) {
  const journey = useJourneyStore((s) => s.journey)
  const settings = journey.settings
  const count = photos.length
  const landscape = settings.orientation === 'landscape'
  const layouts = getAvailableLayouts(count)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const painterRef = useRef<FramePainter | null>(null)
  const latestRef = useRef({ journey, resolved, photos })
  latestRef.current = { journey, resolved, photos }

  // 即時預覽：依這一頁的實際長度循環播放
  useEffect(() => {
    const painter = new FramePainter()
    painterRef.current = painter
    let raf = 0
    let busy = false
    let start = performance.now()
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx || busy) return
      const { journey: j, resolved: r, photos: ps } = latestRef.current
      if (ps.length === 0) return
      const durationMs = computePageDurationMs(r.layout, ps.length, j.settings.secondsPerCell)
      const cycle = durationMs + 600
      const elapsed = (now - start) % cycle
      const progress = Math.min(1, elapsed / durationMs)
      busy = true
      void painter
        .renderPagePreview(ctx, canvas.width, canvas.height, j, {
          photoIds: ps.map((p) => p.id),
          durationMs,
          layout: r.layout,
          motion: r.motion,
          seed: r.seed
        }, progress)
        .finally(() => {
          busy = false
        })
    }
    raf = requestAnimationFrame(loop)
    const restart = () => {
      start = performance.now()
    }
    window.addEventListener('page-preview-restart', restart)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('page-preview-restart', restart)
      painter.disposeBitmaps()
    }
  }, [])

  // 改設定時從頭播放預覽
  const apply = (patch: { layout?: PageLayout | undefined; motion?: PageMotion | undefined }) => {
    onChange(patch)
    window.dispatchEvent(new Event('page-preview-restart'))
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const previewDims = getVideoDimensions(settings.orientation, '720p')
  const currentMotion = page.motion ?? resolved.motion
  const isMotionAuto = !page.motion
  const isLayoutAuto = !page.layout || !layouts.includes(page.layout)

  const setZoom = () => {
    const next: MotionZoom = currentMotion.zoom === 'in' ? 'out' : currentMotion.zoom === 'out' ? 'none' : 'in'
    apply({ motion: { ...currentMotion, zoom: next } })
  }
  const setDirection = (dir: MotionDirection) => {
    apply({ motion: { ...currentMotion, direction: currentMotion.direction === dir ? 'none' : dir } })
  }

  const zoomStyles: Record<MotionZoom, string> = {
    in: 'bg-amber-400 text-slate-950 border-amber-300',
    out: 'bg-rose-500 text-white border-rose-400',
    none: 'bg-slate-600 text-slate-100 border-slate-500'
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="頁面設定"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-slate-700 bg-slate-900 shadow-2xl sm:rounded-2xl"
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
          <div>
            <h2 className="text-base font-bold text-white">頁面設定</h2>
            <p className="text-xs text-slate-400">
              {count} 張照片 · 這一頁約 {(computePageDurationMs(resolved.layout, count, settings.secondsPerCell) / 1000).toFixed(1)} 秒
            </p>
          </div>
          <button
            type="button"
            aria-label="關閉"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-800 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto p-5">
          <div className="flex justify-center rounded-xl bg-slate-950 p-2">
            <canvas
              ref={canvasRef}
              width={previewDims.width}
              height={previewDims.height}
              className={landscape ? 'aspect-video max-h-[34vh] w-auto max-w-full rounded-lg' : 'aspect-[9/16] h-[34vh] w-auto rounded-lg'}
            />
          </div>

          <div className="grid gap-5 md:grid-cols-2">
            {/* 左：拼接樣式 */}
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-200">拼接樣式</h3>
                <button
                  type="button"
                  onClick={() => apply({ layout: undefined })}
                  className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition ${
                    isLayoutAuto ? 'bg-amber-500/15 text-amber-300' : 'text-slate-400 hover:bg-slate-800'
                  }`}
                >
                  <Shuffle className="h-3.5 w-3.5" />
                  <span>自動{isLayoutAuto ? `（${PAGE_LAYOUT_LABELS[resolved.layout]}）` : ''}</span>
                </button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {layouts.map((layout) => {
                  const selected = !isLayoutAuto && page.layout === layout
                  const effective = resolved.layout === layout
                  return (
                    <button
                      key={layout}
                      type="button"
                      onClick={() => apply({ layout })}
                      aria-pressed={selected}
                      className={`flex flex-col items-center gap-1 rounded-xl border px-1 py-2 text-[11px] font-semibold transition ${
                        selected
                          ? 'border-amber-500 bg-amber-500/10 text-amber-200'
                          : effective
                            ? 'border-slate-500 bg-slate-800 text-slate-100'
                            : 'border-slate-700 bg-slate-800/50 text-slate-300 hover:border-slate-500'
                      }`}
                    >
                      <LayoutIcon layout={layout} count={count} landscape={landscape} />
                      <span>{PAGE_LAYOUT_LABELS[layout]}</span>
                    </button>
                  )
                })}
              </div>
              {count === 1 && <p className="text-xs text-slate-500">在編輯區點兩張照片之間的空隙，可以把照片合成同一頁。</p>}
            </section>

            {/* 右：運鏡（米字控制盤） */}
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-200">鏡頭移動</h3>
                <button
                  type="button"
                  onClick={() => apply({ motion: undefined })}
                  className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition ${
                    isMotionAuto ? 'bg-amber-500/15 text-amber-300' : 'text-slate-400 hover:bg-slate-800'
                  }`}
                >
                  <Shuffle className="h-3.5 w-3.5" />
                  <span>自動{isMotionAuto ? `（${describeMotion(resolved.motion)}）` : ''}</span>
                </button>
              </div>
              <div className="flex flex-col items-center gap-3">
                <div className="grid grid-cols-3 gap-2">
                  {PAD.map((cell) => {
                    if (cell === 'center') {
                      return (
                        <button
                          key="center"
                          type="button"
                          onClick={setZoom}
                          title="點擊切換：漸進 → 漸遠 → 不動"
                          className={`flex h-14 w-14 flex-col items-center justify-center rounded-full border-2 text-[11px] font-bold transition ${zoomStyles[currentMotion.zoom]} ${
                            isMotionAuto ? 'opacity-60' : ''
                          }`}
                        >
                          <span className="h-2.5 w-2.5 rounded-full bg-current" />
                          <span className="mt-0.5">{ZOOM_LABELS[currentMotion.zoom]}</span>
                        </button>
                      )
                    }
                    const Icon = DIRECTION_ICONS[cell as Exclude<MotionDirection, 'none'>]
                    const active = currentMotion.direction === cell
                    return (
                      <button
                        key={cell}
                        type="button"
                        aria-label={DIRECTION_LABELS[cell]}
                        aria-pressed={active}
                        onClick={() => setDirection(cell)}
                        className={`flex h-14 w-14 items-center justify-center rounded-xl border transition ${
                          active
                            ? `border-amber-500 bg-amber-500/20 text-amber-300 ${isMotionAuto ? 'opacity-60' : ''}`
                            : 'border-slate-700 bg-slate-800/60 text-slate-400 hover:border-slate-500 hover:text-slate-200'
                        }`}
                      >
                        <Icon className="h-5 w-5" />
                      </button>
                    )
                  })}
                </div>
                <p className="text-center text-xs text-slate-400">
                  中間圓點：<span className="font-semibold text-amber-300">黃＝漸進</span>、
                  <span className="font-semibold text-rose-400">紅＝漸遠</span>、
                  <span className="font-semibold text-slate-300">灰＝不動</span>
                  <br />
                  箭頭：鏡頭往該方向移動，可以和縮放一起使用
                </p>
              </div>
            </section>
          </div>
        </div>

        <div className="flex justify-end border-t border-slate-800 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-amber-500 px-5 py-2 text-sm font-bold text-slate-950 transition hover:bg-amber-400"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  )
}
