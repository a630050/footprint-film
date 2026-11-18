import { Check, ChevronLeft, ChevronRight, Compass, MapPin, Star, X } from 'lucide-react'
import { useEffect } from 'react'
import { formatLocalDateDisplay } from '../domain/capture-time'
import { useModalDialog } from '../hooks/use-modal-dialog'
import { usePhotoObjectUrl } from '../hooks/use-photo-object-url'
import { getStationDisplayName } from '../services/frame-painter'
import { useJourneyStore } from '../store/journey-store'
import type { LocationSource, Station } from '../types/journey'

const LOCATION_LABELS: Record<LocationSource, string> = {
  exif: 'GPS 原始定位',
  inferred: '推定位置',
  manual: '手動指定位置',
  none: '無定位'
}

interface PhotoLightboxModalProps {
  station: Station
  photoIds: string[]
  photoId: string
  onSelectPhoto: (id: string) => void
  onClose: () => void
}

/**
 * 单张照片放大检视对话框
 * 支持左右键切换同站点照片、实时勾选入选、设为封面与编辑专属备注
 */
export function PhotoLightboxModal({
  station,
  photoIds,
  photoId,
  onSelectPhoto,
  onClose
}: PhotoLightboxModalProps) {
  const photosMap = useJourneyStore((s) => s.journey.photos)
  const coverPhotoId = useJourneyStore((s) => s.journey.coverPhotoId)
  const togglePhotoIncluded = useJourneyStore((s) => s.togglePhotoIncluded)
  const setCoverPhoto = useJourneyStore((s) => s.setCoverPhoto)
  const updatePhotoNote = useJourneyStore((s) => s.updatePhotoNote)

  const dialogRef = useModalDialog(true, onClose)
  const photo = photosMap[photoId]
  const url = usePhotoObjectUrl(photo?.imageBlob)

  const currentIdx = photoIds.indexOf(photoId)
  const prevId = currentIdx > 0 ? photoIds[currentIdx - 1] : null
  const nextId = currentIdx >= 0 && currentIdx < photoIds.length - 1 ? photoIds[currentIdx + 1] : null

  useEffect(() => {
    const handleArrow = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'ArrowLeft' && prevId) {
        e.preventDefault()
        onSelectPhoto(prevId)
      } else if (e.key === 'ArrowRight' && nextId) {
        e.preventDefault()
        onSelectPhoto(nextId)
      }
    }
    window.addEventListener('keydown', handleArrow)
    return () => window.removeEventListener('keydown', handleArrow)
  }, [prevId, nextId, onSelectPhoto])

  if (!photo) return null

  const isCover = coverPhotoId === photo.id

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-2 sm:p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`放大檢視：${photo.fileName}`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[94vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl"
      >
        {/* 頂部資訊列 */}
        <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-sm font-bold text-white">
              <span className="truncate">{getStationDisplayName(station)}</span>
              <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-xs text-slate-300">
                {currentIdx + 1} / {photoIds.length}
              </span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <span className="truncate max-w-[220px] sm:max-w-sm">{photo.fileName}</span>
              {photo.localDate && <span>· {formatLocalDateDisplay(photo.localDate)}</span>}
              <span className="inline-flex items-center gap-1 text-amber-300">
                {photo.locationSource === 'inferred' ? (
                  <Compass className="h-3 w-3" />
                ) : (
                  <MapPin className="h-3 w-3" />
                )}
                {LOCATION_LABELS[photo.locationSource]}
              </span>
            </div>
          </div>

          <button
            type="button"
            aria-label="關閉放大檢視"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-800 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* 大圖展示區與左右切換鈕 */}
        <div className="relative flex min-h-[240px] flex-1 items-center justify-center overflow-hidden bg-slate-950 p-2 sm:p-4">
          {url ? (
            <img
              src={url}
              alt={photo.fileName}
              className="max-h-[58vh] w-auto max-w-full rounded-lg object-contain shadow-2xl"
            />
          ) : (
            <div className="h-48 w-64 rounded-lg bg-slate-800" />
          )}

          {prevId && (
            <button
              type="button"
              aria-label="上一張照片"
              onClick={() => onSelectPhoto(prevId)}
              className="absolute left-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-slate-700 bg-slate-900/85 text-white shadow-lg transition hover:bg-slate-800 sm:left-4"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
          )}
          {nextId && (
            <button
              type="button"
              aria-label="下一張照片"
              onClick={() => onSelectPhoto(nextId)}
              className="absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-slate-700 bg-slate-900/85 text-white shadow-lg transition hover:bg-slate-800 sm:right-4"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          )}
        </div>

        {/* 底部操作列：入選切換、設為封面、專屬備註 */}
        <div className="space-y-3 border-t border-slate-800 bg-slate-900/95 p-4 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-pressed={photo.included}
              onClick={() => togglePhotoIncluded(photo.id)}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 font-semibold transition ${
                photo.included
                  ? 'bg-amber-500 text-slate-950 hover:bg-amber-400'
                  : 'border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              <Check className="h-3.5 w-3.5 stroke-[3]" />
              <span>{photo.included ? '已入選影片' : '未入選（點擊加入）'}</span>
            </button>

            <button
              type="button"
              aria-pressed={isCover}
              onClick={() => setCoverPhoto(photo.id)}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 font-semibold transition ${
                isCover
                  ? 'bg-emerald-500 text-slate-950'
                  : 'border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700'
              }`}
            >
              <Star className="h-3.5 w-3.5 fill-current" />
              <span>{isCover ? '目前為封面照片' : '設為封面照片'}</span>
            </button>
          </div>

          <input
            type="text"
            aria-label="照片專屬備註"
            value={photo.note ?? ''}
            onChange={(e) => updatePhotoNote(photo.id, e.target.value)}
            placeholder="填寫這張照片的專屬備註（顯示時會取代站點備註）…"
            className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
          />
        </div>
      </div>
    </div>
  )
}
