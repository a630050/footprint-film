import {
  ArrowLeft,
  ArrowRight,
  Check,
  Compass,
  GitMerge,
  MessageSquare,
  Scissors,
  Star,
  Trash2
} from 'lucide-react'
import { useState } from 'react'
import { formatDateRangeShort } from '../domain/capture-time'
import { usePhotoObjectUrl } from '../hooks/use-photo-object-url'
import { getStationDisplayName } from '../services/frame-painter'
import { useJourneyStore } from '../store/journey-store'
import type { Photo, Station } from '../types/journey'

interface PhotoThumbProps {
  photo: Photo
  index: number
  totalCount: number
  isCover: boolean
  stationId: string
  prevStationId?: string
  nextStationId?: string
  isSelectedForAction: boolean
  onSelectPhoto: (photoId: string) => void
}

function PhotoThumbItem({
  photo,
  isCover,
  isSelectedForAction,
  onSelectPhoto
}: PhotoThumbProps) {
  const url = usePhotoObjectUrl(photo.imageBlob)
  const togglePhotoIncluded = useJourneyStore((s) => s.togglePhotoIncluded)

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', photo.id)
      }}
      onClick={() => onSelectPhoto(photo.id)}
      className={`group relative h-24 w-24 shrink-0 cursor-pointer overflow-hidden rounded-xl border-2 transition ${
        isSelectedForAction
          ? 'border-amber-400 ring-2 ring-amber-400/40'
          : photo.included
            ? 'border-slate-700 hover:border-slate-500'
            : 'border-slate-800 opacity-45'
      }`}
    >
      {url ? (
        <img
          src={url}
          alt={photo.fileName}
          className="h-full w-full object-cover select-none"
        />
      ) : (
        <div className="h-full w-full bg-slate-800" />
      )}

      {/* 入選勾選按鈕 */}
      <button
        type="button"
        title={photo.included ? '入選照片（點擊取消入選）' : '未入選（點擊加入影片）'}
        onClick={(e) => {
          e.stopPropagation()
          togglePhotoIncluded(photo.id)
        }}
        className={`absolute top-1.5 left-1.5 flex h-5 w-5 items-center justify-center rounded-md border text-xs transition ${
          photo.included
            ? 'border-amber-400 bg-amber-500 text-slate-950'
            : 'border-white/50 bg-black/60 text-transparent'
        }`}
      >
        <Check className="h-3.5 w-3.5 stroke-[3]" />
      </button>

      {/* 推定位置圖示 (§4.1) */}
      {photo.locationSource === 'inferred' && (
        <span
          title="推定位置（無原始 GPS，依拍攝時間歸入此站，不參與站點中心點計算）"
          className="absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded bg-amber-500/90 px-1 py-0.5 text-[10px] font-bold text-slate-950 shadow"
        >
          <Compass className="h-2.5 w-2.5" />
          推定
        </span>
      )}

      {/* 封面照片標記 */}
      {isCover && (
        <span className="absolute bottom-1 left-1 flex items-center gap-0.5 rounded bg-emerald-500/95 px-1.5 py-0.5 text-[10px] font-bold text-slate-950">
          <Star className="h-2.5 w-2.5 fill-current" />
          封面
        </span>
      )}

      {/* 有照片備註標記 */}
      {photo.note && photo.note.trim().length > 0 && (
        <span
          title={photo.note}
          className="absolute bottom-1 right-1 rounded bg-slate-900/85 p-1 text-amber-300"
        >
          <MessageSquare className="h-3 w-3" />
        </span>
      )}
    </div>
  )
}

export interface StationCardProps {
  station: Station
  stationIndex: number
  totalStations: number
  prevStation?: Station
  nextStation?: Station
}

/**
 * 單一站點卡片元件 (§4.3)
 * 支援：修改站點名稱、日期範圍顯示、站點備註、照片縮圖列、入選勾選、照片備註、
 * 站點內排序、將照片移至相鄰站點、在指定照片處拆分站點、與下一站合併、刪除站點（全改為不入選）、設為封面
 */
export function StationCard({
  station,
  stationIndex,
  prevStation,
  nextStation
}: StationCardProps) {
  const photosMap = useJourneyStore((s) => s.journey.photos)
  const coverPhotoId = useJourneyStore((s) => s.journey.coverPhotoId)
  const renameStation = useJourneyStore((s) => s.renameStation)
  const updateStationNote = useJourneyStore((s) => s.updateStationNote)
  const mergeWithNextStation = useJourneyStore((s) => s.mergeWithNextStation)
  const splitStationAtPhoto = useJourneyStore((s) => s.splitStationAtPhoto)
  const deleteStation = useJourneyStore((s) => s.deleteStation)
  const updatePhotoNote = useJourneyStore((s) => s.updatePhotoNote)
  const setCoverPhoto = useJourneyStore((s) => s.setCoverPhoto)
  const reorderPhotoInStation = useJourneyStore((s) => s.reorderPhotoInStation)
  const movePhotoToStation = useJourneyStore((s) => s.movePhotoToStation)

  const [selectedPhotoId, setSelectedPhotoId] = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)

  const stationPhotos = station.photoIds
    .map((id) => photosMap[id])
    .filter((p): p is Photo => Boolean(p))

  const includedCount = stationPhotos.filter((p) => p.included).length
  const dateRange = formatDateRangeShort(stationPhotos.map((p) => p.localDate))
  const selectedPhoto = selectedPhotoId ? photosMap[selectedPhotoId] : undefined
  const selectedPhotoIndex = selectedPhotoId
    ? station.photoIds.indexOf(selectedPhotoId)
    : -1

  const handleDropPhoto = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(false)
    const droppedPhotoId = e.dataTransfer.getData('text/plain')
    if (!droppedPhotoId) return
    if (!station.photoIds.includes(droppedPhotoId)) {
      movePhotoToStation(droppedPhotoId, station.id)
    }
  }

  return (
    <div
      id={`station-card-${station.id}`}
      onDragOver={(e) => {
        e.preventDefault()
        setIsDragOver(true)
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDropPhoto}
      className={`rounded-2xl border p-4 transition ${
        isDragOver
          ? 'border-amber-400 bg-amber-500/10'
          : includedCount > 0
            ? 'border-slate-800 bg-slate-900/90'
            : 'border-slate-800/50 bg-slate-900/40 opacity-65'
      }`}
    >
      {/* 頂部：站點編號、名稱輸入、日期範圍、刪除站點 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 flex-1 min-w-[200px]">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-500 text-xs font-bold text-slate-950">
            {stationIndex + 1}
          </span>
          <input
            type="text"
            aria-label="站點名稱"
            value={station.customName ?? ''}
            onChange={(e) => renameStation(station.id, e.target.value)}
            placeholder={station.autoName}
            className="w-full rounded-lg border border-transparent bg-transparent px-2 py-1 text-base font-bold text-white placeholder:text-slate-200 hover:border-slate-700 focus:border-amber-500 focus:bg-slate-950 focus:outline-none focus:placeholder:text-slate-500"
          />
        </div>

        <div className="flex items-center gap-2 text-xs text-slate-400">
          {dateRange && (
            <span className="rounded-md bg-slate-800 px-2 py-1 font-mono text-slate-300">
              {dateRange}
            </span>
          )}
          <span>
            入選 {includedCount}/{stationPhotos.length}
          </span>
          <button
            type="button"
            title="刪除站點（將本站所有照片改為不入選）"
            onClick={() => deleteStation(station.id)}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-500/15 hover:text-rose-400 transition"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* 站點備註欄位 */}
      <div className="mt-2.5">
        <input
          type="text"
          value={station.note ?? ''}
          onChange={(e) => updateStationNote(station.id, e.target.value)}
          placeholder="填寫站點備註（預設顯示於本站所有展示格左下角）…"
          className="w-full rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
        />
      </div>

      {/* 照片縮圖列 */}
      <div className="mt-3 flex gap-2.5 overflow-x-auto pb-2">
        {stationPhotos.map((photo, idx) => (
          <PhotoThumbItem
            key={photo.id}
            photo={photo}
            index={idx}
            totalCount={stationPhotos.length}
            isCover={coverPhotoId === photo.id}
            stationId={station.id}
            prevStationId={prevStation?.id}
            nextStationId={nextStation?.id}
            isSelectedForAction={selectedPhotoId === photo.id}
            onSelectPhoto={(id) =>
              setSelectedPhotoId((prev) => (prev === id ? null : id))
            }
          />
        ))}
      </div>

      {/* 點開單張照片時的詳細操作面板（照片備註、設為封面、排序、移至相鄰站點、拆分站點） */}
      {selectedPhoto && selectedPhotoIndex >= 0 && (
        <div className="mt-3 rounded-xl border border-slate-700/80 bg-slate-950 p-3 space-y-2.5 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-amber-300 truncate max-w-[200px]">
              照片：{selectedPhoto.fileName}
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setCoverPhoto(selectedPhoto.id)}
                className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 font-medium transition ${
                  coverPhotoId === selectedPhoto.id
                    ? 'bg-emerald-500 text-slate-950'
                    : 'bg-slate-800 text-slate-200 hover:bg-slate-700'
                }`}
              >
                <Star className="h-3.5 w-3.5" />
                <span>{coverPhotoId === selectedPhoto.id ? '目前為封面' : '設為封面照片'}</span>
              </button>

              {/* 站點內前後排序 */}
              <button
                type="button"
                disabled={selectedPhotoIndex <= 0}
                onClick={() =>
                  reorderPhotoInStation(
                    station.id,
                    selectedPhotoIndex,
                    selectedPhotoIndex - 1
                  )
                }
                className="inline-flex items-center gap-1 rounded-lg bg-slate-800 px-2 py-1 text-slate-200 hover:bg-slate-700 disabled:opacity-40"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <span>往前排</span>
              </button>
              <button
                type="button"
                disabled={selectedPhotoIndex >= station.photoIds.length - 1}
                onClick={() =>
                  reorderPhotoInStation(
                    station.id,
                    selectedPhotoIndex,
                    selectedPhotoIndex + 1
                  )
                }
                className="inline-flex items-center gap-1 rounded-lg bg-slate-800 px-2 py-1 text-slate-200 hover:bg-slate-700 disabled:opacity-40"
              >
                <span>往後排</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </button>

              {/* 拆分站點：從此張照片開始切為新站點 */}
              {selectedPhotoIndex > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    splitStationAtPhoto(station.id, selectedPhoto.id)
                    setSelectedPhotoId(null)
                  }}
                  className="inline-flex items-center gap-1 rounded-lg bg-amber-500/20 px-2.5 py-1 font-medium text-amber-300 hover:bg-amber-500/30"
                >
                  <Scissors className="h-3.5 w-3.5" />
                  <span>從此張拆分為新站點</span>
                </button>
              )}

              {/* 移至相鄰站點 */}
              {prevStation && (
                <button
                  type="button"
                  onClick={() => {
                    movePhotoToStation(selectedPhoto.id, prevStation.id)
                    setSelectedPhotoId(null)
                  }}
                  className="rounded-lg bg-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-700"
                >
                  移至上一站
                </button>
              )}
              {nextStation && (
                <button
                  type="button"
                  onClick={() => {
                    movePhotoToStation(selectedPhoto.id, nextStation.id)
                    setSelectedPhotoId(null)
                  }}
                  className="rounded-lg bg-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-700"
                >
                  移至下一站
                </button>
              )}
            </div>
          </div>

          <input
            type="text"
            value={selectedPhoto.note ?? ''}
            onChange={(e) => updatePhotoNote(selectedPhoto.id, e.target.value)}
            placeholder="填寫這張照片的專屬備註（顯示時會取代站點備註）…"
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-white placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
          />
        </div>
      )}

      {/* 與下一站合併按鈕 */}
      {nextStation && (
        <div className="mt-3 flex justify-center border-t border-slate-800/80 pt-2.5">
          <button
            type="button"
            onClick={() => mergeWithNextStation(station.id)}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-medium text-slate-400 hover:bg-slate-800 hover:text-amber-300 transition"
          >
            <GitMerge className="h-3.5 w-3.5" />
            <span>與下一站「{getStationDisplayName(nextStation)}」合併</span>
          </button>
        </div>
      )}
    </div>
  )
}
