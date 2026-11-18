import { Loader2, Maximize, Minimize, Pause, Play, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getVideoDimensions } from '../constants/video-config'
import { locateTimelinePosition } from '../domain/timeline-builder'
import { useJourneySummary } from '../hooks/use-journey-summary'
import { usePreviewMusic } from '../hooks/use-preview-music'
import { FramePainter, getStationDisplayName } from '../services/frame-painter'
import { DeterministicMapRenderer } from '../services/map-renderer'
import { useJourneyStore } from '../store/journey-store'

/** 播放時更新時間軸滑桿顯示的間隔（毫秒）；畫面本身每幀都會重畫，但不必每幀觸發 React 重新渲染 */
const SCRUBBER_UPDATE_INTERVAL_MS = 100

/** 兩次點擊／觸控在這個間隔內視為雙擊（手機 Safari 不一定會送出 dblclick，因此自己判斷） */
const DOUBLE_TAP_INTERVAL_MS = 300

type FullscreenCapableElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void }
type FullscreenCapableDocument = Document & {
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
}

function getNativeFullscreenElement(): Element | null {
  const doc = document as FullscreenCapableDocument
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null
}

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
  const playerRef = useRef<HTMLDivElement | null>(null)
  const lastTapRef = useRef(0)
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
  const [mapRetryCount, setMapRetryCount] = useState(0)
  const [isNativeFullscreen, setIsNativeFullscreen] = useState(false)
  /** 不支援元素全螢幕的瀏覽器（iPhone Safari）改用鋪滿視窗的假全螢幕 */
  const [isPseudoFullscreen, setIsPseudoFullscreen] = useState(false)
  const isFullscreen = isNativeFullscreen || isPseudoFullscreen

  // 預覽固定以 720p 畫布繪製，兼顧流暢度與清晰度
  const previewDims = getVideoDimensions(journey.settings.orientation, '720p')
  const totalDurationMs = summary.totalDurationMs

  journeyRef.current = journey
  timelineRef.current = summary.timeline

  usePreviewMusic(journey, isPlaying, timeRef, totalDurationMs)

  // 避免與配樂試聽同時出聲：開始預覽時停止下方試聽，下方試聽時暫停預覽
  useEffect(() => {
    if (isPlaying) {
      window.dispatchEvent(new Event('stop-music-audition'))
    }
  }, [isPlaying])

  useEffect(() => {
    const pausePreview = () => setIsPlaying(false)
    window.addEventListener('pause-preview-player', pausePreview)
    return () => window.removeEventListener('pause-preview-player', pausePreview)
  }, [])

  // 計算各段落的起始時間點與目前播放段落標籤，供狀態徽章與快速跳轉使用
  const chapterStops = useMemo(() => {
    const stationMap = new Map(journey.stations.map((s) => [s.id, s]))
    const stationOrderMap = new Map(journey.stations.map((s, i) => [s.id, i + 1]))
    const stops: { key: string; label: string; startMs: number; endMs: number }[] = []
    let acc = 0
    for (let i = 0; i < summary.timeline.length; i++) {
      const seg = summary.timeline[i]
      const startMs = acc
      const endMs = acc + seg.durationMs
      acc = endMs
      if (seg.type === 'INTRO') {
        stops.push({ key: `intro-${i}`, label: '片頭', startMs, endMs })
      } else if (seg.type === 'OPENING_LOCATOR') {
        stops.push({ key: `open-${i}`, label: '開場定位', startMs, endMs })
      } else if (seg.type === 'STATION') {
        const st = stationMap.get(seg.stationId)
        const num = stationOrderMap.get(seg.stationId) ?? ''
        stops.push({
          key: `st-${seg.stationId}`,
          label: `站點 ${num}${st ? `：${getStationDisplayName(st)}` : ''}`,
          startMs,
          endMs
        })
      } else if (seg.type === 'OUTRO') {
        stops.push({ key: `outro-${i}`, label: '片尾', startMs, endMs })
      }
    }
    return stops
  }, [summary.timeline, journey.stations])

  const currentSegmentLabel = useMemo(() => {
    const located = locateTimelinePosition(summary.timeline, displayTimeMs)
    if (!located) return null
    const seg = summary.timeline[located.segmentIndex]
    if (!seg) return null
    if (seg.type === 'INTRO') return '🎬 片頭'
    if (seg.type === 'OPENING_LOCATOR') return '🌍 開場定位'
    if (seg.type === 'OUTRO') return '🎞️ 片尾'
    if (seg.type === 'STATION') {
      const idx = journey.stations.findIndex((s) => s.id === seg.stationId)
      const st = idx >= 0 ? journey.stations[idx] : undefined
      return `📍 站點 ${idx + 1}：${getStationDisplayName(st)}`
    }
    const target = journey.stations.find((s) => s.id === seg.toStationId)
    const icon = seg.routeKind === 'flight' ? '✈️' : '🚗'
    return `${icon} 前往 ${getStationDisplayName(target)}`
  }, [summary.timeline, displayTimeMs, journey.stations])

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
  }, [previewDims.width, previewDims.height, requestRender, mapRetryCount])

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

  useEffect(() => {
    const onChange = () => setIsNativeFullscreen(getNativeFullscreenElement() === playerRef.current)
    document.addEventListener('fullscreenchange', onChange)
    document.addEventListener('webkitfullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      document.removeEventListener('webkitfullscreenchange', onChange)
    }
  }, [])

  // 假全螢幕時按 Esc 離開，並暫停頁面捲動
  useEffect(() => {
    if (!isPseudoFullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsPseudoFullscreen(false)
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKey)
    }
  }, [isPseudoFullscreen])

  const toggleFullscreen = async () => {
    const doc = document as FullscreenCapableDocument
    // 已在全螢幕（真的或假的）：一律離開
    if (isPseudoFullscreen || getNativeFullscreenElement()) {
      setIsPseudoFullscreen(false)
      if (getNativeFullscreenElement()) {
        await (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.())
      }
      return
    }
    const el = playerRef.current as FullscreenCapableElement | null
    if (!el) return
    try {
      const request = el.requestFullscreen
        ? el.requestFullscreen()
        : el.webkitRequestFullscreen
          ? el.webkitRequestFullscreen()
          : Promise.reject(new Error('unsupported'))
      // 部分 App 內建瀏覽器（例如 LINE）的全螢幕請求不會回應，1 秒內沒進入全螢幕就改用假全螢幕
      await Promise.race([request, new Promise((resolve) => setTimeout(resolve, 1000))])
      if (getNativeFullscreenElement() !== el) throw new Error('not entered')
    } catch {
      setIsPseudoFullscreen(true)
      return
    }
    // 手機上播放橫式影片時嘗試轉成橫向（僅部分 Android 瀏覽器支援，失敗就維持原方向）
    if (journey.settings.orientation === 'landscape') {
      const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }
      await orientation?.lock?.('landscape').catch(() => undefined)
    }
  }

  const handleCanvasPointerUp = () => {
    const now = performance.now()
    if (now - lastTapRef.current < DOUBLE_TAP_INTERVAL_MS) {
      lastTapRef.current = 0
      void toggleFullscreen()
    } else {
      lastTapRef.current = now
    }
  }

  const seekTo = (ms: number) => {
    timeRef.current = ms
    setDisplayTimeMs(ms)
    requestRender()
  }

  return (
    <div
      ref={playerRef}
      className={
        isFullscreen
          ? `flex flex-col gap-3 bg-black p-2 sm:p-4 ${isPseudoFullscreen ? 'fixed inset-0 z-50' : 'h-full w-full'}`
          : 'rounded-2xl border border-slate-800 bg-slate-900/90 p-4 shadow-xl space-y-4'
      }
    >
      {!isFullscreen && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-slate-200">
              即時預覽（{journey.settings.orientation === 'landscape' ? '橫式 16:9' : '直式 9:16'}）
            </span>
            {currentSegmentLabel && (
              <span className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300">
                {currentSegmentLabel}
              </span>
            )}
          </div>
          <span>雙擊畫面切換全螢幕 · 預覽時地圖偶爾延遲屬正常</span>
        </div>
      )}

      <div
        className={
          isFullscreen
            ? 'relative flex min-h-0 flex-1 items-center justify-center'
            : 'relative flex justify-center bg-slate-950/90 rounded-xl p-2 border border-slate-800/80'
        }
      >
        <canvas
          ref={canvasRef}
          width={previewDims.width}
          height={previewDims.height}
          onPointerUp={handleCanvasPointerUp}
          title="雙擊切換全螢幕"
          className={`touch-manipulation select-none ${
            isFullscreen
              ? 'h-full w-full object-contain'
              : `rounded-lg shadow-2xl ${
                  journey.settings.orientation === 'landscape'
                    ? 'aspect-video w-full max-w-3xl'
                    : 'aspect-[9/16] h-[62vh] max-h-[640px] w-auto'
                }`
          }`}
        />
        {!isMapReady && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-slate-300">
            {mapError ? (
              <span className="flex flex-col items-center gap-2 text-center">
                <span className="text-rose-300">{mapError}</span>
                <button
                  type="button"
                  onClick={() => setMapRetryCount((n) => n + 1)}
                  className="rounded-lg bg-amber-500 px-3 py-1.5 font-bold text-slate-950 hover:bg-amber-400 transition"
                >
                  重新載入地圖
                </button>
              </span>
            ) : (
              <>
                <Loader2 className="h-4 w-4 animate-spin text-amber-400" />
                <span>正在載入地圖…</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* 手機：時間軸獨佔一列、按鈕在下一列；寬螢幕排成一列 */}
      <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:gap-3">
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
          className="order-first min-w-0 basis-full accent-amber-500 sm:order-none sm:flex-1 sm:basis-auto"
        />

        <span className="ml-auto shrink-0 text-right font-mono text-xs text-slate-300 sm:ml-0 sm:w-24">
          {formatMmSs(displayTimeMs)} / {formatMmSs(totalDurationMs)}
        </span>

        <button
          type="button"
          title={isFullscreen ? '離開全螢幕' : '全螢幕'}
          aria-label={isFullscreen ? '離開全螢幕' : '全螢幕'}
          onClick={() => void toggleFullscreen()}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700 transition"
        >
          {isFullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
        </button>
      </div>

      {/* 段落與站點快速跳轉膠囊 */}
      {!isFullscreen && chapterStops.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="快速跳轉至段落或站點">
          {chapterStops.map((stop) => {
            const isActive =
              displayTimeMs >= stop.startMs &&
              (displayTimeMs < stop.endMs || stop.endMs >= totalDurationMs)
            return (
              <button
                key={stop.key}
                type="button"
                onClick={() => seekTo(stop.startMs)}
                className={`max-w-[160px] shrink-0 truncate rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${
                  isActive
                    ? 'border-amber-500 bg-amber-500/15 text-amber-300'
                    : 'border-slate-800 bg-slate-950/70 text-slate-400 hover:border-slate-600 hover:text-slate-200'
                }`}
              >
                {stop.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
