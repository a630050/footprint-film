import { useEffect, useRef } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ')

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  )
}

/**
 * 统一管理弹出窗口（Modal）的无障碍行为
 * - 开启时锁定背景滚动并记录原先焦点
 * - 支持 Escape 键关闭
 * - 限制 Tab / Shift+Tab 焦点循环在弹窗内（Focus Trap）
 * - 关闭后将焦点还原至触发元素
 */
export function useModalDialog<T extends HTMLElement = HTMLDivElement>(
  isOpen: boolean,
  onClose: () => void
) {
  const dialogRef = useRef<T | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!isOpen) return

    const previousActive = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    // 延後至下一微任務，確保彈窗內的 DOM 已掛載完成再移動焦點
    const focusFrame = requestAnimationFrame(() => {
      const container = dialogRef.current
      if (!container) return
      if (!container.contains(document.activeElement)) {
        const focusables = getFocusableElements(container)
        if (focusables.length > 0) {
          focusables[0].focus()
        } else {
          container.focus()
        }
      }
    })

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
        return
      }

      if (e.key !== 'Tab') return
      const container = dialogRef.current
      if (!container) return

      const focusables = getFocusableElements(container)
      if (focusables.length === 0) {
        e.preventDefault()
        return
      }

      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const current = document.activeElement

      if (e.shiftKey) {
        if (current === first || !container.contains(current)) {
          e.preventDefault()
          last.focus()
        }
      } else if (current === last || !container.contains(current)) {
        e.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      cancelAnimationFrame(focusFrame)
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
      if (previousActive && typeof previousActive.focus === 'function') {
        previousActive.focus()
      }
    }
  }, [isOpen])

  return dialogRef
}
