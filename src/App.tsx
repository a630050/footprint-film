import { AlertOctagon, Compass, Film, History, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ExportPanel } from './components/ExportPanel'
import { JourneyEditor } from './components/JourneyEditor'
import { PhotoPicker } from './components/PhotoPicker'
import { CreditsFooter } from './components/CreditsFooter'
import { PreviewPlayer } from './components/PreviewPlayer'
import { TravelerMarkerPicker } from './components/TravelerMarkerPicker'
import { isWebCodecsSupported } from './services/browser-support'
import { useJourneyStore } from './store/journey-store'

/**
 * 旅遊軌跡影片生成網站主應用元件
 * 涵蓋：
 * - §6 進入時檢查瀏覽器是否具備 WebCodecs，不支援時即提示「請改用 Chrome 或 Safari」
 * - §4.6 進入網站時若有草稿，詢問「繼續上次的旅程」或「開始新的旅程」
 * - 三步驟流程切換（① 選照片 → ② 編輯旅程 → ③ 預覽與輸出）
 */
export function App() {
  const currentStep = useJourneyStore((s) => s.currentStep)
  const setCurrentStep = useJourneyStore((s) => s.setCurrentStep)
  const pendingDraft = useJourneyStore((s) => s.pendingDraft)
  const resumePendingDraft = useJourneyStore((s) => s.resumePendingDraft)
  const discardPendingDraftAndReset = useJourneyStore(
    (s) => s.discardPendingDraftAndReset
  )
  const checkInitialDraft = useJourneyStore((s) => s.checkInitialDraft)
  const hasPhotos = useJourneyStore(
    (s) => Object.keys(s.journey.photos).length > 0
  )

  const [supportedBrowser, setSupportedBrowser] = useState(true)

  useEffect(() => {
    setSupportedBrowser(isWebCodecsSupported())
    void checkInitialDraft()
  }, [checkInitialDraft])

  // §6 不支援 WebCodecs 的瀏覽器：進入網站即顯示提示，不讓使用者編輯完才發現無法輸出
  if (!supportedBrowser) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 p-6 text-slate-100">
        <div className="max-w-md rounded-2xl border border-rose-500/40 bg-slate-900 p-6 text-center shadow-2xl space-y-4">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-500/20 text-rose-400">
            <AlertOctagon className="h-8 w-8" />
          </div>
          <h1 className="text-xl font-bold text-white">您的瀏覽器不支援影片編碼功能</h1>
          <p className="text-sm leading-relaxed text-slate-300">
            本工具使用瀏覽器內建的硬體影片編碼（WebCodecs API）在您的裝置上直接輸出 MP4 短片。
            <strong className="mt-2 block text-amber-400">
              請改用 Chrome 或 Safari 開啟本網頁。
            </strong>
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* 頂部導覽列與步驟指示器 */}
      <header className="border-b border-slate-800/80 bg-slate-900/75 backdrop-blur sticky top-0 z-30">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500 text-slate-950 font-bold">
              <Compass className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-base font-bold tracking-tight text-white">
                足跡影片
              </h1>
              <p className="text-[11px] text-slate-400">
                純本機處理 · 自動分站與地圖軌跡動畫
              </p>
            </div>
          </div>

          {/* 三步驟切換列 */}
          <nav className="flex items-center gap-1.5 text-xs font-semibold">
            <button
              type="button"
              onClick={() => setCurrentStep(1)}
              className={`rounded-xl px-3 py-1.5 transition ${
                currentStep === 1
                  ? 'bg-amber-500 text-slate-950'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              ① 選照片
            </button>
            <span className="text-slate-700">/</span>
            <button
              type="button"
              disabled={!hasPhotos}
              onClick={() => setCurrentStep(2)}
              className={`rounded-xl px-3 py-1.5 transition ${
                currentStep === 2
                  ? 'bg-amber-500 text-slate-950'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-40'
              }`}
            >
              ② 編輯旅程
            </button>
            <span className="text-slate-700">/</span>
            <button
              type="button"
              disabled={!hasPhotos}
              onClick={() => setCurrentStep(3)}
              className={`rounded-xl px-3 py-1.5 transition ${
                currentStep === 3
                  ? 'bg-amber-500 text-slate-950'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-40'
              }`}
            >
              ③ 預覽與輸出
            </button>
          </nav>
        </div>
      </header>

      {/* §4.6 偵測到上次未完成草稿時的詢問橫幅 */}
      {pendingDraft && (
        <div className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-3">
          <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 text-amber-200">
              <History className="h-4 w-4 shrink-0 text-amber-400" />
              <span>
                系統發現您上次有一份尚未完成的旅程草稿「
                <strong className="text-white">{pendingDraft.title}</strong>」（共{' '}
                {Object.keys(pendingDraft.photos).length} 張照片、
                {pendingDraft.stations.length} 個站點）。
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={resumePendingDraft}
                className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-3 py-1.5 font-bold text-slate-950 hover:bg-amber-400 transition"
              >
                <Film className="h-3.5 w-3.5" />
                <span>繼續上次的旅程</span>
              </button>
              <button
                type="button"
                onClick={() => void discardPendingDraftAndReset()}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 font-medium text-slate-300 hover:bg-slate-800 transition"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>開始新的旅程</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 主要內容區 */}
      <main className="flex-1">
        {currentStep === 1 && <PhotoPicker />}
        {currentStep === 2 && <JourneyEditor />}
        {currentStep === 3 && (
          <div className="mx-auto max-w-4xl space-y-5 px-4 py-5">
            <PreviewPlayer />
            <TravelerMarkerPicker />
            <ExportPanel />
          </div>
        )}
      </main>

      <CreditsFooter />
    </div>
  )
}
export default App
