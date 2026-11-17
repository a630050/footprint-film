import { ImagePlus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { drawTravelerMarker } from '../services/traveler-marker'
import { useJourneyStore } from '../store/journey-store'
import type { TravelerMarkerStyle } from '../types/journey'
import { AvatarCropper } from './AvatarCropper'

const PREVIEW_SIZE = 72

const OPTIONS: { style: TravelerMarkerStyle; label: string }[] = [
  { style: 'dot', label: '圓點' },
  { style: 'person', label: '小人' },
  { style: 'avatar', label: '大頭照' }
]

/** 以實際的繪製函式畫出選項縮圖，確保與影片中的樣子一致 */
function MarkerPreview({ style, avatar }: { style: TravelerMarkerStyle; avatar: ImageBitmap | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = Math.min(3, window.devicePixelRatio || 1)
    canvas.width = PREVIEW_SIZE * dpr
    canvas.height = PREVIEW_SIZE * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    // 縮圖統一放大到差不多填滿方框
    const ui = (style === 'dot' ? 1.3 : style === 'person' ? 0.85 : 0.68) * dpr
    drawTravelerMarker(ctx, canvas.width / 2, canvas.height / 2, style, ui, 0.15, avatar)
  }, [style, avatar])

  return <canvas ref={canvasRef} style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE }} aria-hidden="true" />
}

/**
 * 移動標記選擇：圓點（預設）、小人、自己上傳並裁切的圓形大頭照
 */
export function TravelerMarkerPicker() {
  const travelerMarker = useJourneyStore((s) => s.journey.settings.travelerMarker ?? 'dot')
  const travelerAvatar = useJourneyStore((s) => s.journey.travelerAvatar)
  const updateSettings = useJourneyStore((s) => s.updateSettings)
  const setTravelerAvatar = useJourneyStore((s) => s.setTravelerAvatar)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [cropFile, setCropFile] = useState<File | null>(null)
  const [avatarBitmap, setAvatarBitmap] = useState<ImageBitmap | null>(null)

  useEffect(() => {
    if (!travelerAvatar) {
      setAvatarBitmap(null)
      return
    }
    let cancelled = false
    let bmp: ImageBitmap | null = null
    void createImageBitmap(travelerAvatar)
      .then((result) => {
        if (cancelled) {
          result.close()
          return
        }
        bmp = result
        setAvatarBitmap(result)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      bmp?.close()
    }
  }, [travelerAvatar])

  const pickAvatarFile = () => fileInputRef.current?.click()

  const handleSelect = (style: TravelerMarkerStyle) => {
    if (style === 'avatar' && !travelerAvatar) {
      pickAvatarFile()
      return
    }
    updateSettings({ travelerMarker: style })
  }

  return (
    <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/90 p-4 shadow-xl">
      <div>
        <h3 className="text-sm font-semibold text-slate-200">移動標記</h3>
        <p className="mt-0.5 text-xs text-slate-400">在站點之間沿著路線前進的圖示</p>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {OPTIONS.map(({ style, label }) => {
          const selected = travelerMarker === style
          return (
            <button
              key={style}
              type="button"
              onClick={() => handleSelect(style)}
              aria-pressed={selected}
              className={`flex flex-col items-center gap-1 rounded-xl border px-2 py-2.5 text-xs font-semibold transition ${
                selected
                  ? 'border-amber-500 bg-amber-500/10 text-amber-200'
                  : 'border-slate-700 bg-slate-800/60 text-slate-300 hover:border-slate-500'
              }`}
            >
              {style === 'avatar' && !avatarBitmap ? (
                <span
                  className="flex items-center justify-center rounded-full border-2 border-dashed border-slate-500 text-slate-400"
                  style={{ width: 56, height: 56, margin: 8 }}
                >
                  <ImagePlus className="h-5 w-5" />
                </span>
              ) : (
                <MarkerPreview style={style} avatar={avatarBitmap} />
              )}
              <span>{style === 'avatar' && !travelerAvatar ? '上傳大頭照' : label}</span>
            </button>
          )
        })}
      </div>

      {travelerAvatar && (
        <div className="flex flex-wrap justify-end gap-2 text-xs">
          <button
            type="button"
            onClick={pickAvatarFile}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 font-medium text-slate-300 transition hover:bg-slate-700"
          >
            <ImagePlus className="h-3.5 w-3.5" />
            <span>更換大頭照</span>
          </button>
          <button
            type="button"
            onClick={() => setTravelerAvatar(undefined)}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 font-medium text-slate-300 transition hover:bg-slate-700"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>移除大頭照</span>
          </button>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,.heic,.heif"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) setCropFile(file)
        }}
      />

      {cropFile && (
        <AvatarCropper
          file={cropFile}
          onCancel={() => setCropFile(null)}
          onSave={(blob) => {
            setTravelerAvatar(blob)
            setCropFile(null)
          }}
        />
      )}
    </div>
  )
}
