import { Loader2, Pause, Play, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { getVideoDimensions } from '../constants/video-config'
import { useJourneySummary } from '../hooks/use-journey-summary'
import { FramePainter } from '../services/frame-painter'
import { DeterministicMapRenderer } from '../services/map-renderer'
import { useJourneyStore } from '../store/journey-store'

/** 播放時更新時間軸滑桿顯示的間隔（毫秒）；畫面本身每幀都會重畫，但不必每幀觸發 React 重新渲染 */
const SCRUBBER_UPDATE_INTERVAL_MS = 100

function formatMmSs(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * 步驟 ③：即時預覽播放器 (§4.5 & §5.2.3)
 * - 依所選方向顯示 16:9 或 9:16 預覽播放器，可播放、暫停、拖拉時間軸
 * - 與輸出共用同一個 `cameraAt` 與 `FramePainter`，以 `requestAnimationFrame` 即時驅動（不等待圖磚）
 * - 同一時間只會有一幀在繪製：繪製期間若時間又前進，只保留「最新」一次重畫請求，避免舊幀晚到蓋掉新幀
 */
export function PreviewPlayer() {
  const journey = useJourneyStore((s) => s.journey)
  const summary = useJourneySummary()

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const mapRendererRef = useRef<DeterministicMapRenderer | null>(null)
  const framePainterRef = useRef<FramePainter | null>(null)

  const timeRef = useRef(0)
  const journeyRef = useRef(journey)
  const timelineRef = useRef(summary.timeline)
  const isRenderingRef = useRef(false)
  const needsRenderRef = useRef(false)

  const [isPlaying, setIsPlaying] = useState(false)
  const [displayTimeMs, setDisplayTimeMs] = useState(0)
  const [isMapReady, setIsMapReady] = useState(false)
  const [mapError, setMapError] = useState<string | null>(null)

  // 預覽固定以 720p 畫布繪製，兼顧流暢度與清晰度
  const previewDims = getVideoDimensions(journey.settings.orientation, '720p')
  const totalDurationMs = summary.totalDurationMs

  journeyRef.current = journey
  timelineRef.current = summary.timeline

  const requestRender = useCallback(() => {
    if (isRenderingRef.current) {
      needsRenderRef.current = true
      return
    }
    const canvas = canvasRef.current
    const mapRenderer = mapRendererRef.current
    const painter = framePainterRef.current
    if (!canvas || !mapRenderer || !painter || !mapRenderer.ready) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    isRenderingRef.current = true
    const timeMs = timeRef.current
    void painter
      .renderFrameAtTime(
        ctx,
        canvas.width,
        canvas.height,
        journeyRef.current,
        timelineRef.current,
        timeMs,
        mapRenderer,
        false
      )
      .catch(() => undefined)
      .finally(() => {
        painter.prefetchUpcomingPhotos(journeyRef.current, timelineRef.current, timeMs)
        isRenderingRef.current = false
        if (needsRenderRef.current) {
          needsRenderRef.current = false
          requestRender()
        }
      })
  }, [])

  // 初始化離屏地圖與 FramePainter（方向改變時重建）
  useEffect(() => {
    const mapRenderer = new DeterministicMapRenderer()
    const painter = new FramePainter()
    mapRendererRef.current = mapRenderer
    framePainterRef.current = painter
    setIsMapReady(false)

    let cancelled = false
    setMapError(null)
    mapRenderer
      .initialize(previewDims.width, previewDims.height)
      .then(() => {
        if (cancelled) return
        setIsMapReady(true)
        requestRender()
      })
      .catch((err: unknown) => {
        if (!cancelled) setMapError(err instanceof Error ? err.message : '地圖載入失敗')
      })

    return () => {
      cancelled = true
      painter.disposeBitmaps()
      mapRenderer.destroy()
      mapRendererRef.current = null
      framePainterRef.current = null
    }
  }, [previewDims.width, previewDims.height, requestRender])

  // 旅程內容或時間軸改變時重畫目前這一幀
  useEffect(() => {
    if (timeRef.current > totalDurationMs) {
      timeRef.current = totalDurationMs
      setDisplayTimeMs(totalDurationMs)
    }
    requestRender()
  }, [journey, summary.timeline, totalDurationMs, requestRender])

  // requestAnimationFrame 播放迴圈
  useEffect(() => {
    if (!isPlaying || totalDurationMs <= 0) return

    let rafId = 0
    let lastTimestamp = performance.now()
    let lastScrubberUpdate = 0

    const tick = (now: number) => {
      const deltaMs = Math.min(100, now - lastTimestamp) // 分頁切回前景時避免一次跳太遠
      lastTimestamp = now
      const next = Math.min(totalDurationMs, timeRef.current + deltaMs)
      timeRef.current = next
      requestRender()

      if (now - lastScrubberUpdate >= SCRUBBER_UPDATE_INTERVAL_MS || next >= totalDurationMs) {
        lastScrubberUpdate = now
        setDisplayTimeMs(next)
      }

      if (next >= totalDurationMs) {
        setIsPlaying(false)
        return
      }
      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [isPlaying, totalDurationMs, requestRender])

  const seekTo = (ms: number) => {
    timeRef.current = ms
    setDisplayTimeMs(ms)
    requestRender()
  }

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-4 shadow-xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
        <span className="font-semibold text-slate-200">
          即時預覽（{journey.settings.orientation === 'landscape' ? '橫式 16:9' : '直式 9:16'}）
        </span>
        <span>預覽時地圖圖磚偶爾延遲屬正常現象，正式輸出會逐幀等待完整繪製</span>
      </div>

      <div className="relative flex justify-center bg-slate-950/90 rounded-xl p-2 border border-slate-800/80">
        <canvas
          ref={canvasRef}
          width={previewDims.width}
          height={previewDims.height}
          className={`rounded-lg shadow-2xl ${
            journey.settings.orientation === 'landscape'
              ? 'aspect-video w-full max-w-3xl'
              : 'aspect-[9/16] h-[62vh] max-h-[640px] w-auto'
          }`}
        />
        {!isMapReady && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-slate-300">
            {mapError ? (
              <span className="text-rose-300">{mapError}</span>
            ) : (
              <>
                <Loader2 className="h-4 w-4 animate-spin text-amber-400" />
                <span>正在載入地圖…</span>
              </>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-label={isPlaying ? '暫停' : '播放'}
          disabled={!isMapReady || totalDurationMs <= 0}
          onClick={() => {
            if (timeRef.current >= totalDurationMs) seekTo(0)
            setIsPlaying((p) => !p)
          }}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500 text-slate-950 hover:bg-amber-400 disabled:opacity-40 transition"
        >
          {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 fill-current" />}
        </button>

        <button
          type="button"
          title="回到開頭"
          aria-label="回到開頭"
          onClick={() => {
            setIsPlaying(false)
            seekTo(0)
          }}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700 transition"
        >
          <RotateCcw className="h-4 w-4" />
        </button>

        <input
          type="range"
          aria-label="播放進度"
          min={0}
          max={Math.max(1, totalDurationMs)}
          step={33}
          value={displayTimeMs}
          onChange={(e) => {
            setIsPlaying(false)
            seekTo(Number(e.target.value))
          }}
          className="flex-1 accent-amber-500"
        />

        <span className="w-24 text-right font-mono text-xs text-slate-300">
          {formatMmSs(displayTimeMs)} / {formatMmSs(totalDurationMs)}
        </span>
      </div>
    </div>
  )
}
