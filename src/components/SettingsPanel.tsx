import { ChevronDown, ChevronUp, SlidersHorizontal } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { useModalDialog } from '../hooks/use-modal-dialog'
import { useJourneyStore } from '../store/journey-store'

/** 滑桿停止拖動多久後才真正套用（毫秒）：拖動過程中不重新分站，也不發出地名／路線查詢 */
const SLIDER_COMMIT_DELAY_MS = 450

/**
 * 滑桿的「顯示值」與「套用值」分離：拖動時只更新顯示，停止拖動後才呼叫 onCommit
 */
function useDeferredSlider(committedValue: number, onCommit: (value: number) => void) {
  const [draft, setDraft] = useState(committedValue)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit

  useEffect(() => {
    setDraft(committedValue)
  }, [committedValue])

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const change = (value: number) => {
    setDraft(value)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      if (value !== committedValue) onCommitRef.current(value)
    }, SLIDER_COMMIT_DELAY_MS)
  }

  const reset = () => setDraft(committedValue)

  return { draft, change, reset }
}

/** 開關列：標題、說明與勾選框 */
function ToggleRow({
  title,
  description,
  checked,
  onChange
}: {
  title: string
  description: ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
      <div>
        <div className="font-medium text-slate-200">{title}</div>
        <div className="text-[11px] text-slate-400">{description}</div>
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 shrink-0 rounded accent-amber-500"
      />
    </label>
  )
}

/** 連拍門檻的顯示文字 */
function formatBurstThreshold(sec: number): string {
  if (sec <= 0) return '關閉'
  if (sec < 60) return `${sec} 秒`
  return sec % 60 === 0 ? `${sec / 60} 分鐘` : `${(sec / 60).toFixed(1)} 分鐘`
}

/**
 * 可收合的旅程設定區 (§4.3)
 * 包含：旅程標題、影片方向、分站半徑、長途門檻、每格秒數（1–4 秒，預設 2）、自動拼圖與隨機開關
 * 預設展開；標題列同時顯示精簡摘要，收合後仍可一眼看到目前設定
 * 當調整分站半徑且已有手動編輯時，先跳出確認對話框
 */
export function SettingsPanel() {
  const journey = useJourneyStore((s) => s.journey)
  const updateJourneyTitle = useJourneyStore((s) => s.updateJourneyTitle)
  const updateSettings = useJourneyStore((s) => s.updateSettings)
  const reclusterWithRadius = useJourneyStore((s) => s.reclusterWithRadius)

  // 依使用者要求預設展開，讓隨機、連拍門檻等選項一進來就看得到
  const [isOpen, setIsOpen] = useState(true)
  const [pendingRadiusKm, setPendingRadiusKm] = useState<number | null>(null)
  const titleId = useId()
  const radiusId = useId()
  const thresholdId = useId()
  const burstId = useId()
  const panelId = useId()

  const handleRadiusChange = (newRadius: number) => {
    if (journey.hasManualStationEdits) {
      setPendingRadiusKm(newRadius)
    } else {
      reclusterWithRadius(newRadius)
    }
  }

  const radiusSlider = useDeferredSlider(journey.settings.stationRadiusKm, handleRadiusChange)
  const thresholdSlider = useDeferredSlider(journey.settings.longDistanceThresholdKm, (value) =>
    updateSettings({ longDistanceThresholdKm: value })
  )
  const burstSlider = useDeferredSlider(journey.settings.burstThresholdSec, (value) =>
    updateSettings({ burstThresholdSec: value })
  )

  const confirmRecluster = () => {
    if (pendingRadiusKm !== null) {
      reclusterWithRadius(pendingRadiusKm)
      setPendingRadiusKm(null)
    }
  }

  const cancelRecluster = () => {
    setPendingRadiusKm(null)
    radiusSlider.reset()
  }

  const reclusterDialogRef = useModalDialog(pendingRadiusKm !== null, cancelRecluster)

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/90">
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={() => setIsOpen((v) => !v)}
        className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left text-sm font-semibold text-slate-200 hover:bg-slate-800/50 transition rounded-xl"
      >
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-amber-400" />
          <span>旅程標題與進階設定</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1 text-[11px] font-medium text-slate-300">
            {journey.settings.orientation === 'landscape' ? '橫式 16:9' : '直式 9:16'} · 分站 {journey.settings.stationRadiusKm}km · 每頁 {journey.settings.secondsPerCell}秒
          </span>
          {isOpen ? (
            <ChevronUp className="h-4 w-4 text-slate-400" />
          ) : (
            <ChevronDown className="h-4 w-4 text-slate-400" />
          )}
        </div>
      </button>

      {isOpen && (
        <div id={panelId} className="border-t border-slate-800 p-4 space-y-4 text-xs">
          {/* 旅程標題與影片方向 */}
          <div className="grid gap-4 sm:grid-cols-12">
            <div className="space-y-1.5 sm:col-span-7">
              <label htmlFor={titleId} className="block font-medium text-slate-300">
                旅程標題（片頭與片尾共用）
              </label>
              <input
                id={titleId}
                type="text"
                value={journey.title}
                onChange={(e) => updateJourneyTitle(e.target.value)}
                placeholder="例如：桃園 → 漢米頓"
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-amber-500 focus:outline-none"
              />
            </div>

            <div className="space-y-1.5 sm:col-span-5">
              <span className="block font-medium text-slate-300">影片方向（影響自動拼圖）</span>
              <div className="grid grid-cols-2 gap-2" role="group" aria-label="影片方向">
                <button
                  type="button"
                  aria-pressed={journey.settings.orientation === 'landscape'}
                  onClick={() => updateSettings({ orientation: 'landscape' })}
                  className={`rounded-lg py-2 font-semibold transition ${
                    journey.settings.orientation === 'landscape'
                      ? 'bg-amber-500 text-slate-950'
                      : 'border border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  橫式 16:9
                </button>
                <button
                  type="button"
                  aria-pressed={journey.settings.orientation === 'portrait'}
                  onClick={() => updateSettings({ orientation: 'portrait' })}
                  className={`rounded-lg py-2 font-semibold transition ${
                    journey.settings.orientation === 'portrait'
                      ? 'bg-amber-500 text-slate-950'
                      : 'border border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  直式 9:16
                </button>
              </div>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {/* 分站半徑 */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-slate-300">
                <label htmlFor={radiusId} className="font-medium">分站半徑</label>
                <span className="font-mono text-amber-400">
                  {radiusSlider.draft} km
                </span>
              </div>
              <input
                id={radiusId}
                type="range"
                min={1}
                max={50}
                step={1}
                value={radiusSlider.draft}
                onChange={(e) => radiusSlider.change(Number(e.target.value))}
                className="w-full accent-amber-500"
              />
              <p className="text-[11px] text-slate-400">
                相鄰照片超過此距離即切為新站點（預設 10km）
              </p>
            </div>

            {/* 長途門檻 */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-slate-300">
                <label htmlFor={thresholdId} className="font-medium">長途門檻</label>
                <span className="font-mono text-amber-400">
                  {thresholdSlider.draft} km
                </span>
              </div>
              <input
                id={thresholdId}
                type="range"
                min={20}
                max={500}
                step={10}
                value={thresholdSlider.draft}
                onChange={(e) => thresholdSlider.change(Number(e.target.value))}
                className="w-full accent-amber-500"
              />
              <p className="text-[11px] text-slate-400">
                超過此距離畫飛行大圓弧線，未超過畫陸路路線（預設 100km）
              </p>
            </div>

            {/* 每格秒數 */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-slate-300">
                <span className="font-medium">每頁秒數</span>
                <span className="font-mono text-amber-400">
                  {journey.settings.secondsPerCell} 秒
                </span>
              </div>
              <div className="flex gap-2" role="group" aria-label="每頁秒數">
                {[1, 2, 3, 4].map((sec) => (
                  <button
                    key={sec}
                    type="button"
                    aria-pressed={journey.settings.secondsPerCell === sec}
                    onClick={() => updateSettings({ secondsPerCell: sec })}
                    className={`flex-1 rounded-lg py-1.5 font-medium transition ${
                      journey.settings.secondsPerCell === sec
                        ? 'bg-amber-500 text-slate-950'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    {sec} 秒
                  </button>
                ))}
              </div>
            </div>

            {/* 連拍門檻 */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-slate-300">
                <label htmlFor={burstId} className="font-medium">連拍門檻</label>
                <span className="font-mono text-amber-400">{formatBurstThreshold(burstSlider.draft)}</span>
              </div>
              <input
                id={burstId}
                type="range"
                min={0}
                max={300}
                step={10}
                value={burstSlider.draft}
                onChange={(e) => burstSlider.change(Number(e.target.value))}
                className="w-full accent-amber-500"
              />
              <p className="text-[11px] text-slate-400">
                同一站內相隔不超過此時間的照片自動合成同一頁（預設 1 分鐘，拉到最左關閉）
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <ToggleRow
              title="自動拼圖"
              description="橫式影片連續直拍併為 2~3 張；直式影片連續橫拍併為 2 張"
              checked={journey.settings.autoCollage}
              onChange={(checked) => updateSettings({ autoCollage: checked })}
            />
            <ToggleRow
              title="拼接隨機"
              description="沒有手動指定樣式的多張頁面，隨機搭配拼接樣式"
              checked={journey.settings.randomLayout}
              onChange={(checked) => updateSettings({ randomLayout: checked })}
            />
            <ToggleRow
              title="鏡頭移動隨機"
              description="沒有手動指定運鏡的頁面，隨機搭配漸進、漸遠與平移"
              checked={journey.settings.randomMotion}
              onChange={(checked) => updateSettings({ randomMotion: checked })}
            />
          </div>
          <p className="text-xs text-slate-400">
            自動拼圖與連拍門檻只影響還沒手動分頁的站點；在站點中手動指定的樣式與運鏡不受隨機影響。
          </p>
        </div>
      )}

      {/* 調整分站半徑時的確認對話框 (§4.3) */}
      {pendingRadiusKm !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={cancelRecluster}
        >
          <div
            ref={reclusterDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="recluster-confirm-title"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            className="max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl space-y-4"
          >
            <h4 id="recluster-confirm-title" className="text-base font-bold text-white">確認重新分站？</h4>
            <p className="text-sm leading-relaxed text-slate-300">
              重新分站會清除站點名稱、站點備註、合併／拆分與分頁設定；照片備註與入選勾選會保留。
            </p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={cancelRecluster}
                className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
              >
                取消
              </button>
              <button
                type="button"
                onClick={confirmRecluster}
                className="rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400"
              >
                確認重新分站（{pendingRadiusKm} km）
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
