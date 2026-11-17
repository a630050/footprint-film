import { useEffect, useState } from 'react'

/**
 * 將照片 Blob 轉為 Object URL，並在元件卸載或 Blob 變更時自動呼叫 revokeObjectURL，避免記憶體洩漏
 * @param blob 影像 Blob
 * @returns Object URL 字串或 undefined
 */
export function usePhotoObjectUrl(blob?: Blob): string | undefined {
  const [url, setUrl] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!blob) {
      setUrl(undefined)
      return
    }
    const objectUrl = URL.createObjectURL(blob)
    setUrl(objectUrl)
    return () => {
      URL.revokeObjectURL(objectUrl)
    }
  }, [blob])

  return url
}
