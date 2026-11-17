import { Redo2, Undo2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useJourneyStore } from '../store/journey-store'

/** 是否為 Mac（顯示 ⌘ 而不是 Ctrl） */
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = IS_MAC ? '⌘' : 'Ctrl'

/** 焦點在文字輸入框時，Ctrl+Z 交給瀏覽器復原文字，不復原旅程編輯 */
function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true
  if (target instanceof HTMLInputElement) {
    return !['range', 'checkbox', 'radio', 'button', 'submit', 'file', 'color'].includes(target.type)
  }
  return false
}

/**
 * 全域快捷鍵：Ctrl+Z（Mac 為 ⌘Z）復原上一步，Ctrl+Shift+Z 或 Ctrl+Y 重做
 */
export function useUndoShortcuts(): void {
  const undo = useJourneyStore((s) => s.undo)
  const redo = useJourneyStore((s) => s.redo)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      if (isTextEditingTarget(e.target)) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undo, redo])
}

/** 頁首的復原／重做按鈕（手機沒有鍵盤也能用） */
export function UndoRedoButtons() {
  const canUndo = useJourneyStore((s) => s.history.past.length > 0)
  const canRedo = useJourneyStore((s) => s.history.future.length > 0)
  const undo = useJourneyStore((s) => s.undo)
  const redo = useJourneyStore((s) => s.redo)

  const buttonClass =
    'flex h-8 w-8 items-center justify-center rounded-lg text-slate-300 transition hover:bg-slate-800 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent'

  return (
    <div className="flex items-center gap-0.5">
      <button type="button" onClick={undo} disabled={!canUndo} title={`復原上一步（${MOD}+Z）`} aria-label="復原上一步" className={buttonClass}>
        <Undo2 className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={redo}
        disabled={!canRedo}
        title={`重做（${MOD}+Shift+Z）`}
        aria-label="重做"
        className={buttonClass}
      >
        <Redo2 className="h-4 w-4" />
      </button>
    </div>
  )
}

/** 復原／重做後短暫顯示的提示 */
export function HistoryToast() {
  const notice = useJourneyStore((s) => s.historyNotice)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!notice) return
    setVisible(true)
    const timer = setTimeout(() => setVisible(false), 1800)
    return () => clearTimeout(timer)
  }, [notice])

  if (!notice || !visible) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 top-20 z-40 flex justify-center px-4" role="status" aria-live="polite">
      <div className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/95 px-4 py-2 text-sm text-slate-200 shadow-2xl">
        {notice.kind === 'undo' ? <Undo2 className="h-4 w-4 text-amber-400" /> : <Redo2 className="h-4 w-4 text-amber-400" />}
        <span>{notice.kind === 'undo' ? `已復原上一步（${MOD}+Shift+Z 重做）` : '已重做'}</span>
      </div>
    </div>
  )
}
