import { Undo2, X } from 'lucide-react'
import { useEffect } from 'react'
import { useJourneyStore } from '../store/journey-store'

/** 提示列顯示多久後自動消失（毫秒） */
const TOAST_DURATION_MS = 6000

/**
 * 刪除照片後畫面下方的提示列：「已刪除 · 復原」，數秒後自動消失
 */
export function DeletedPhotoToast() {
  const lastDeleted = useJourneyStore((s) => s.lastDeletedPhoto)
  const undo = useJourneyStore((s) => s.undoDeletePhoto)
  const dismiss = useJourneyStore((s) => s.dismissDeletedPhoto)

  useEffect(() => {
    if (!lastDeleted) return
    const timer = setTimeout(dismiss, TOAST_DURATION_MS)
    return () => clearTimeout(timer)
  }, [lastDeleted, dismiss])

  if (!lastDeleted) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4" role="status" aria-live="polite">
      <div className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-slate-700 bg-slate-900/95 py-2 pl-4 pr-2 text-sm text-slate-200 shadow-2xl backdrop-blur">
        <span className="max-w-[45vw] truncate">已刪除「{lastDeleted.photo.fileName}」</span>
        <button
          type="button"
          onClick={undo}
          className="inline-flex items-center gap-1 rounded-xl bg-amber-500 px-3 py-1.5 text-xs font-bold text-slate-950 transition hover:bg-amber-400"
        >
          <Undo2 className="h-3.5 w-3.5" />
          <span>復原</span>
        </button>
        <button
          type="button"
          aria-label="關閉"
          onClick={dismiss}
          className="flex h-8 w-8 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-800 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
