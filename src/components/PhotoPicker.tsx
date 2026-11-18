import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  HelpCircle,
  ImagePlus,
  Loader2,
  ShieldCheck,
  Smartphone
} from 'lucide-react'
import { useRef, useState } from 'react'
import { MAX_PHOTOS_PER_BATCH } from '../constants/video-config'
import { useJourneySummary } from '../hooks/use-journey-summary'
import { useModalDialog } from '../hooks/use-modal-dialog'
import {
  processPhotoFilesSequentially,
  type BatchPhotoReadProgress
} from '../services/photo-reader'
import { useJourneyStore } from '../store/journey-store'

/**
 * 步驟 ①：選照片元件
 * 涵蓋：選取檔案（上限 100 張）、影片檔略過提示、重複照片過濾、iOS/Android 保留定位說明、隱私說明、逐張讀取縮小進度與統計
 */
export function PhotoPicker() {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const existingPhotosMap = useJourneyStore((s) => s.journey.photos)
  const orientation = useJourneyStore((s) => s.journey.settings.orientation)
  const appendUploadedPhotos = useJourneyStore((s) => s.appendUploadedPhotos)
  const updateSettings = useJourneyStore((s) => s.updateSettings)
  const setCurrentStep = useJourneyStore((s) => s.setCurrentStep)
  const summary = useJourneySummary()
  const hasManualStationEdits = useJourneyStore((s) => s.journey.hasManualStationEdits)
  const [showAppendConfirm, setShowAppendConfirm] = useState(false)
  const appendDialogRef = useModalDialog(showAppendConfirm, () => setShowAppendConfirm(false))

  // 加入新照片會依時間重新分站；若使用者已手動編輯過站點，先確認（與調整分站半徑的規則一致）
  const openFilePicker = () => {
    if (hasManualStationEdits && summary.totalCount > 0) {
      setShowAppendConfirm(true)
      return
    }
    fileInputRef.current?.click()
  }

  const [isReading, setIsReading] = useState(false)
  const [progress, setProgress] = useState<BatchPhotoReadProgress | null>(null)
  const [showLocationGuide, setShowLocationGuide] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files
    if (!fileList || fileList.length === 0) return

    const allFiles = Array.from(fileList)
    e.target.value = ''

    const nextWarnings: string[] = []
    let filesToProcess = allFiles

    if (allFiles.length > MAX_PHOTOS_PER_BATCH) {
      nextWarnings.push(
        `一次最多可選取 ${MAX_PHOTOS_PER_BATCH} 張照片（您選了 ${allFiles.length} 個檔案），已先處理前 ${MAX_PHOTOS_PER_BATCH} 個，其餘請分次挑選。`
      )
      filesToProcess = allFiles.slice(0, MAX_PHOTOS_PER_BATCH)
    }

    setIsReading(true)
    setWarnings(nextWarnings)

    try {
      const result = await processPhotoFilesSequentially(
        filesToProcess,
        (p) => {
          setProgress(p)
        },
        Object.values(existingPhotosMap)
      )

      if (result.skippedVideos.length > 0) {
        nextWarnings.push(
          `第一版不支援影片，已略過 ${result.skippedVideos.length} 個影片檔（${result.skippedVideos.slice(0, 3).join('、')}${result.skippedVideos.length > 3 ? '…' : ''}）。`
        )
      }

      if (result.skippedDuplicates.length > 0) {
        nextWarnings.push(
          `已自動略過 ${result.skippedDuplicates.length} 張重複選取的照片（${result.skippedDuplicates.slice(0, 3).join('、')}${result.skippedDuplicates.length > 3 ? '…' : ''}）。`
        )
      }

      if (result.failedFiles.length > 0) {
        nextWarnings.push(
          `有 ${result.failedFiles.length} 個檔案無法讀取或格式不支援，已略過。`
        )
      }

      setWarnings([...nextWarnings])

      if (result.photos.length > 0) {
        appendUploadedPhotos(result.photos)
      }
    } finally {
      setIsReading(false)
      setProgress(null)
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6">
      {/* 主選取區 */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl">
        <div className="flex flex-col items-center text-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-400">
            <ImagePlus className="h-8 w-8" />
          </div>
          <h2 className="text-xl font-bold text-white">選取這趟旅行的照片</h2>
          <p className="mt-1 text-sm text-slate-400">
            支援 JPG、PNG、WebP、HEIC，一次最多 {MAX_PHOTOS_PER_BATCH} 張（可分次加入）
          </p>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              disabled={isReading}
              onClick={openFilePicker}
              className="inline-flex items-center gap-2 rounded-xl bg-amber-500 px-6 py-3 font-semibold text-slate-950 shadow-lg shadow-amber-500/20 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isReading ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <span>正在讀取與縮小照片…</span>
                </>
              ) : (
                <>
                  <ImagePlus className="h-5 w-5" />
                  <span>{summary.totalCount > 0 ? '繼續加入照片' : '選擇旅行照片'}</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => setShowLocationGuide((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/70 px-4 py-3 text-sm font-medium text-slate-200 transition hover:bg-slate-800"
            >
              <HelpCircle className="h-4 w-4 text-amber-400" />
              <span>手機如何保留照片定位？</span>
            </button>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".jpg,.jpeg,.png,.webp,.heic,.heif,image/jpeg,image/png,image/webp,image/heic,image/heif,video/*"
            onChange={handleFileChange}
            className="hidden"
          />

          {/* 隱私說明文案（嚴格依 §8） */}
          <div className="mt-5 flex items-start gap-2.5 rounded-xl bg-slate-950/70 p-3.5 text-left text-xs leading-relaxed text-slate-400 border border-slate-800/80">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            <p>
              照片只在你的裝置上處理，不會上傳。為了顯示地名與路線，站點的大致位置會傳送給開源地圖服務（OpenStreetMap）。
            </p>
          </div>
        </div>

        {/* iOS / Android 保留定位操作說明 */}
        {showLocationGuide && (
          <div className="mt-5 grid gap-3 rounded-xl border border-slate-800 bg-slate-950/90 p-4 text-left text-xs text-slate-300 sm:grid-cols-2">
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 font-semibold text-amber-400">
                <Smartphone className="h-4 w-4" />
                <span>iPhone / iPad (iOS Safari)</span>
              </div>
              <ol className="list-decimal space-y-1 pl-4 text-slate-400">
                <li>點選「選擇旅行照片」打開照片選單。</li>
                <li>點選選單底部或角落的「選項」（Options）。</li>
                <li>開啟「位置」（包含位置資訊），再點完成。</li>
              </ol>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 font-semibold text-amber-400">
                <Smartphone className="h-4 w-4" />
                <span>Android (Chrome)</span>
              </div>
              <ol className="list-decimal space-y-1 pl-4 text-slate-400">
                <li>若從系統相簿選取被抹除定位，建議點選檔案選擇器中的「瀏覽 / 檔案」。</li>
                <li>從 `DCIM/Camera` 資料夾直接選取原始照片即可完整保留 GPS。</li>
              </ol>
            </div>
          </div>
        )}

        {/* 讀取進度條 */}
        {isReading && progress && (
          <div className="mt-5 space-y-2 rounded-xl border border-slate-800 bg-slate-950 p-4">
            <div className="flex items-center justify-between text-xs text-slate-300">
              <span className="truncate max-w-[70%]">
                正在處理：{progress.currentFileName || '準備中'}
              </span>
              <span className="font-mono">
                {progress.completedCount} / {progress.totalCount}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full bg-amber-500 transition-all duration-200"
                style={{
                  width: `${progress.totalCount > 0 ? Math.round((progress.completedCount / progress.totalCount) * 100) : 0}%`
                }}
              />
            </div>
          </div>
        )}
      </div>

      {showAppendConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setShowAppendConfirm(false)}
        >
          <div
            ref={appendDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="append-confirm-title"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            className="max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl space-y-4"
          >
            <h4 id="append-confirm-title" className="text-base font-bold text-white">加入照片會重新分站</h4>
            <p className="text-sm leading-relaxed text-slate-300">
              新照片會和現有照片一起依時間重新分站，這會清除站點名稱、站點備註與合併／拆分設定；照片備註與入選勾選會保留。
            </p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowAppendConfirm(false)}
                className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowAppendConfirm(false)
                  fileInputRef.current?.click()
                }}
                className="rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400"
              >
                繼續選擇照片
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 警告與提示訊息 */}
      {warnings.length > 0 && (
        <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-200">
          {warnings.map((w, idx) => (
            <div key={idx} className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      {/* 完成後顯示統計 (§4.1) */}
      {summary.totalCount > 0 && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-5 shadow-lg space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-400" />
              <h3 className="font-semibold text-white">
                已載入 {summary.totalCount} 張照片
              </h3>
            </div>
            <span className="text-xs text-slate-400">
              預估影片長度：{summary.formattedDuration}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-xl bg-slate-950/80 p-3 border border-slate-800">
              <div className="text-lg font-bold text-emerald-400">{summary.exifCount} 張</div>
              <div className="text-xs text-slate-400">有定位</div>
            </div>
            <div className="rounded-xl bg-slate-950/80 p-3 border border-slate-800">
              <div className="text-lg font-bold text-amber-400">{summary.inferredCount} 張</div>
              <div className="text-xs text-slate-400">推定位置</div>
            </div>
            <div className="rounded-xl bg-slate-950/80 p-3 border border-slate-800">
              <div className="text-lg font-bold text-rose-400">{summary.unassignedCount} 張</div>
              <div className="text-xs text-slate-400">未歸類</div>
            </div>
          </div>

          <p className="text-xs text-slate-400 text-center">
            {summary.exifCount} 張有定位、{summary.inferredCount} 張推定位置、{summary.unassignedCount} 張未歸類
          </p>

          {/* 提前選擇影片方向，讓步驟 ② 的自動拼圖與單頁預覽依正確比例排版 */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/70 px-3.5 py-2.5">
            <span className="text-xs font-medium text-slate-300">影片方向</span>
            <div className="flex gap-2" role="group" aria-label="影片方向">
              <button
                type="button"
                aria-pressed={orientation === 'landscape'}
                onClick={() => updateSettings({ orientation: 'landscape' })}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                  orientation === 'landscape'
                    ? 'bg-amber-500 text-slate-950'
                    : 'border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
                }`}
              >
                橫式 16:9
              </button>
              <button
                type="button"
                aria-pressed={orientation === 'portrait'}
                onClick={() => updateSettings({ orientation: 'portrait' })}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                  orientation === 'portrait'
                    ? 'bg-amber-500 text-slate-950'
                    : 'border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
                }`}
              >
                直式 9:16
              </button>
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="button"
              onClick={() => setCurrentStep(2)}
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400"
            >
              <span>下一步：編輯旅程</span>
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
