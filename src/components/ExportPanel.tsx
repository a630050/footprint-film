import {
  AlertTriangle,
  ArrowLeft,
  Download,
  Film,
  Loader2,
  Share2,
  XCircle
} from 'lucide-react'
import { useRef, useState } from 'react'
import { useJourneySummary } from '../hooks/use-journey-summary'
import type { VideoExportProgress } from '../services/video-exporter'
import { useJourneyStore } from '../store/journey-store'

/**
 * 步驟 ③：輸出設定、進度與分享／下載面板 (§4.5)
 * - 輸出設定：方向（橫式 16:9 / 直式 9:16）、解析度（1080p / 720p）
 * - 輸出中：顯示進度條、「請勿切換 App 或鎖定螢幕」提示、取消按鈕
 * - 不支援 1080p 時自動降級為 720p 並告知
 * - 完成後：手機以 Web Share API 開啟系統分享選單；桌機直接下載 `.mp4`
 */
export function ExportPanel() {
  const journey = useJourneyStore((s) => s.journey)
  const updateSettings = useJourneyStore((s) => s.updateSettings)
  const setCurrentStep = useJourneyStore((s) => s.setCurrentStep)
  const summary = useJourneySummary()

  const abortControllerRef = useRef<AbortController | null>(null)
  const [isExporting, setIsExporting] = useState(false)
  const [progress, setProgress] = useState<VideoExportProgress | null>(null)
  const [exportedBlob, setExportedBlob] = useState<Blob | null>(null)
  const [downgradeNotice, setDowngradeNotice] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const handleStartExport = async () => {
    setErrorMsg(null)
    setDowngradeNotice(null)
    setExportedBlob(null)
    setIsExporting(true)

    const controller = new AbortController()
    abortControllerRef.current = controller

    try {
      // 影片編碼模組（含 Mediabunny）只在真正輸出時才載入，縮短首頁載入時間
      const { exportJourneyVideoMp4 } = await import('../services/video-exporter')
      const res = await exportJourneyVideoMp4(journey, summary.timeline, {
        signal: controller.signal,
        onProgress: (p) => {
          setProgress(p)
          if (p.downgradedTo720p) {
            setDowngradeNotice(
              '您的裝置硬體編碼器不支援 1080p H.264，已自動改用 720p 進行輸出。'
            )
          }
        }
      })
      setExportedBlob(res.mp4Blob)
      if (res.incompleteMapFrames > 0) {
        setDowngradeNotice(
          `有 ${res.incompleteMapFrames} 幀地圖在等待逾時前未完整載入（網路較慢或不穩），影片中可能出現缺塊，建議網路穩定時重新輸出。`
        )
      }
      if (res.audioSkipped) {
        setDowngradeNotice('這個瀏覽器無法編碼音訊，影片已輸出但沒有配樂。建議改用最新版 Chrome、Edge 或 Safari。')
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setErrorMsg('已取消影片輸出。')
      } else {
        setErrorMsg(err instanceof Error ? err.message : '輸出影片時發生未知錯誤')
      }
    } finally {
      setIsExporting(false)
      abortControllerRef.current = null
    }
  }

  const handleCancelExport = () => {
    abortControllerRef.current?.abort()
  }

  const getSafeFileName = () => {
    const cleanTitle = (journey.title || '旅遊軌跡回憶')
      .replace(/[\\/:*?"<>|]/g, '_')
      .trim()
    return `${cleanTitle}.mp4`
  }

  const handleDownloadMp4 = () => {
    if (!exportedBlob) return
    const url = URL.createObjectURL(exportedBlob)
    const a = document.createElement('a')
    a.href = url
    a.download = getSafeFileName()
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const canUseWebShare = (): boolean => {
    if (typeof navigator === 'undefined' || !navigator.canShare || !exportedBlob) {
      return false
    }
    try {
      const file = new File([exportedBlob], getSafeFileName(), { type: 'video/mp4' })
      return navigator.canShare({ files: [file] })
    } catch {
      return false
    }
  }

  const handleShareMp4 = async () => {
    if (!exportedBlob) return
    try {
      const file = new File([exportedBlob], getSafeFileName(), { type: 'video/mp4' })
      await navigator.share({
        title: journey.title || '旅遊軌跡回憶',
        files: [file]
      })
    } catch {
      // 使用者關閉分享選單時忽略
    }
  }

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-5 shadow-xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          disabled={isExporting}
          onClick={() => setCurrentStep(2)}
          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-40 transition"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>返回步驟 ② 編輯旅程</span>
        </button>

        <div className="text-xs text-slate-400">
          總長度：<strong className="text-amber-400">{summary.formattedDuration}</strong>（30fps MP4）
        </div>
      </div>

      {/* 輸出設定：方向與解析度 */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-slate-300">影片方向</label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={isExporting}
              onClick={() => updateSettings({ orientation: 'landscape' })}
              className={`rounded-xl py-2.5 text-xs font-semibold transition ${
                journey.settings.orientation === 'landscape'
                  ? 'bg-amber-500 text-slate-950'
                  : 'border border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-800'
              }`}
            >
              橫式 16:9（預設）
            </button>
            <button
              type="button"
              disabled={isExporting}
              onClick={() => updateSettings({ orientation: 'portrait' })}
              className={`rounded-xl py-2.5 text-xs font-semibold transition ${
                journey.settings.orientation === 'portrait'
                  ? 'bg-amber-500 text-slate-950'
                  : 'border border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-800'
              }`}
            >
              直式 9:16
            </button>
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-slate-300">影片解析度</label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={isExporting}
              onClick={() => updateSettings({ resolution: '1080p' })}
              className={`rounded-xl py-2.5 text-xs font-semibold transition ${
                journey.settings.resolution === '1080p'
                  ? 'bg-amber-500 text-slate-950'
                  : 'border border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-800'
              }`}
            >
              1080p Full HD（預設）
            </button>
            <button
              type="button"
              disabled={isExporting}
              onClick={() => updateSettings({ resolution: '720p' })}
              className={`rounded-xl py-2.5 text-xs font-semibold transition ${
                journey.settings.resolution === '720p'
                  ? 'bg-amber-500 text-slate-950'
                  : 'border border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-800'
              }`}
            >
              720p HD（較省時）
            </button>
          </div>
        </div>
      </div>

      {/* 1080p 自動降級告知 */}
      {downgradeNotice && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
          <span>{downgradeNotice}</span>
        </div>
      )}

      {/* 輸出中進度條與「請勿切換 App 或鎖定螢幕」提示 (§4.5) */}
      {isExporting && progress && (
        <div className="rounded-xl border border-amber-500/30 bg-slate-950 p-4 space-y-3">
          <div className="flex items-center justify-between text-xs">
            <span className="inline-flex items-center gap-2 font-semibold text-amber-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>
                {progress.phase === 'prewarming'
                  ? '正在預熱地圖圖磚快取…'
                  : progress.phase === 'encoding'
                    ? `正在逐幀渲染與編碼（${progress.currentFrame} / ${progress.totalFrames} 幀）`
                    : progress.phase === 'paused'
                      ? '已暫停：網頁在背景時無法編碼，回到此頁面後會自動繼續'
                      : '正在封裝 MP4 影片檔…'}
              </span>
            </span>
            <span className="font-mono font-bold text-white">{progress.percent}%</span>
          </div>

          <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full bg-amber-500 transition-all duration-150"
              style={{ width: `${progress.percent}%` }}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <p className="text-xs font-medium text-amber-200/90">
              ⚠️ 輸出期間請勿切換 App 或鎖定螢幕；切到背景時會自動暫停，回來後繼續。
            </p>
            <button
              type="button"
              onClick={handleCancelExport}
              className="inline-flex items-center gap-1 rounded-lg border border-rose-500/50 bg-rose-500/10 px-3 py-1 text-xs font-semibold text-rose-300 hover:bg-rose-500/20"
            >
              <XCircle className="h-3.5 w-3.5" />
              <span>取消輸出</span>
            </button>
          </div>
        </div>
      )}

      {errorMsg && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
          {errorMsg}
        </div>
      )}

      {/* 開始輸出按鈕 */}
      {!isExporting && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <button
            type="button"
            onClick={handleStartExport}
            className="inline-flex items-center gap-2 rounded-xl bg-amber-500 px-6 py-3 text-sm font-bold text-slate-950 shadow-lg shadow-amber-500/20 hover:bg-amber-400 transition"
          >
            <Film className="h-5 w-5" />
            <span>{exportedBlob ? '重新輸出 MP4 影片' : '開始輸出 MP4 影片'}</span>
          </button>
        </div>
      )}

      {/* 輸出完成後：手機開啟系統分享選單（Web Share API）、桌機直接下載 .mp4 */}
      {exportedBlob && !isExporting && (
        <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs space-y-0.5">
            <div className="font-bold text-emerald-300 text-sm">
              🎉 影片輸出完成！（{(exportedBlob.size / (1024 * 1024)).toFixed(1)} MB）
            </div>
            <div className="text-slate-300">
              手機可點選「分享／存入相簿」，電腦可直接下載 `.mp4` 檔案。
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {canUseWebShare() && (
              <button
                type="button"
                onClick={handleShareMp4}
                className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2.5 text-xs font-bold text-slate-950 hover:bg-emerald-400 transition"
              >
                <Share2 className="h-4 w-4" />
                <span>分享 / 存入手機相簿</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleDownloadMp4}
              className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-400/50 bg-slate-950 px-4 py-2.5 text-xs font-bold text-emerald-300 hover:bg-slate-900 transition"
            >
              <Download className="h-4 w-4" />
              <span>下載 MP4 檔案</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
