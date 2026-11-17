import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import {
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Check,
  Compass,
  GitMerge,
  MessageSquare,
  Scissors,
  Settings2,
  Star,
  Trash2,
  X
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { formatDateRangeShort } from '../domain/capture-time'
import {
  hasBreakBetween,
  movePhotoInPages,
  PAGE_LAYOUT_LABELS,
  resolvePageStyle,
  resolveStationPages,
  togglePageBreak,
  updatePageStyle
} from '../domain/pages'
import { usePhotoObjectUrl } from '../hooks/use-photo-object-url'
import { getStationDisplayName } from '../services/frame-painter'
import { useJourneyStore } from '../store/journey-store'
import type { PageLayout, PageMotion, Photo, Station, StationPage } from '../types/journey'
import { describeMotion, LayoutIcon, PageStyleDialog } from './PageStyleDialog'

/* ───────────── 縮圖 ───────────── */

interface PhotoThumbProps {
  photo: Photo
  isCover: boolean
  isSelected: boolean
  onSelect: () => void
  onDelete: () => void
}

function PhotoThumbContent({ photo, isCover }: { photo: Photo; isCover: boolean }) {
  const url = usePhotoObjectUrl(photo.imageBlob)
  return (
    <>
      {url ? (
        <img src={url} alt={photo.fileName} draggable={false} className="h-full w-full select-none object-cover" />
      ) : (
        <div className="h-full w-full bg-slate-800" />
      )}
      <div className="pointer-events-none absolute bottom-1 left-1 flex flex-col items-start gap-0.5">
        {photo.locationSource === 'inferred' && (
          <span
            title="推定位置（無原始 GPS，依拍攝時間歸入此站，不參與站點中心點計算）"
            className="flex items-center gap-0.5 rounded bg-amber-500/90 px-1 py-0.5 text-[10px] font-bold text-slate-950 shadow"
          >
            <Compass className="h-2.5 w-2.5" />
            推定
          </span>
        )}
        {isCover && (
          <span className="flex items-center gap-0.5 rounded bg-emerald-500/95 px-1.5 py-0.5 text-[10px] font-bold text-slate-950">
            <Star className="h-2.5 w-2.5 fill-current" />
            封面
          </span>
        )}
      </div>
      {photo.note && photo.note.trim().length > 0 && (
        <span title={photo.note} className="pointer-events-none absolute bottom-1 right-1 rounded bg-slate-900/85 p-1 text-amber-300">
          <MessageSquare className="h-3 w-3" />
        </span>
      )}
    </>
  )
}

function SortablePhotoThumb({ photo, isCover, isSelected, onSelect, onDelete }: PhotoThumbProps) {
  const togglePhotoIncluded = useJourneyStore((s) => s.togglePhotoIncluded)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: photo.id })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onClick={onSelect}
      className={`group relative h-24 w-24 shrink-0 cursor-grab touch-manipulation overflow-hidden rounded-xl border-2 transition-colors active:cursor-grabbing ${
        isDragging ? 'z-10 opacity-30' : ''
      } ${
        isSelected
          ? 'border-amber-400 ring-2 ring-amber-400/40'
          : photo.included
            ? 'border-slate-700 hover:border-slate-500'
            : 'border-slate-800 opacity-45'
      }`}
    >
      <PhotoThumbContent photo={photo} isCover={isCover} />

      {/* 入選勾選 */}
      <button
        type="button"
        title={photo.included ? '入選照片（點擊取消入選）' : '未入選（點擊加入影片）'}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          togglePhotoIncluded(photo.id)
        }}
        className={`absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-md border text-xs transition ${
          photo.included ? 'border-amber-400 bg-amber-500 text-slate-950' : 'border-white/50 bg-black/60 text-transparent'
        }`}
      >
        <Check className="h-3.5 w-3.5 stroke-[3]" />
      </button>

      {/* 刪除：滑鼠移過去才出現；觸控裝置選取後出現 */}
      <button
        type="button"
        title="刪除這張照片"
        aria-label="刪除這張照片"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        className={`absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-white transition hover:bg-rose-500 focus:opacity-100 ${
          isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 [@media(hover:none)]:hidden'
        }`}
      >
        <X className="h-3.5 w-3.5 stroke-[3]" />
      </button>
    </div>
  )
}

/* ───────────── 照片之間的分隔線開關 ───────────── */

function PageGapToggle({ isBreak, onToggle }: { isBreak: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={isBreak ? '點擊取消分隔線（與前一頁合併）' : '點擊加上分隔線（從這裡分成新的一頁）'}
      aria-label={isBreak ? '取消分隔線' : '加上分隔線'}
      className={`group/gap flex h-24 shrink-0 items-center justify-center transition ${isBreak ? 'w-6' : 'w-3'}`}
    >
      <span
        className={`block rounded-full transition ${
          isBreak
            ? 'h-20 w-1 bg-amber-400 group-hover/gap:bg-rose-400'
            : 'h-10 w-0.5 bg-transparent group-hover/gap:h-16 group-hover/gap:bg-amber-400/60 [@media(hover:none)]:bg-slate-600'
        }`}
      />
    </button>
  )
}

/* ───────────── 站點卡片 ───────────── */

export interface StationCardProps {
  station: Station
  stationIndex: number
  totalStations: number
  prevStation?: Station
  nextStation?: Station
}

/**
 * 單一站點卡片 (§4.3)
 * - 照片依「頁」分組顯示：拖曳排序、點兩張照片之間的空隙加上／取消分隔線
 * - 每頁下方的設定條：開啟頁面設定視窗（拼接樣式＋運鏡）
 * - 站點名稱、備註、刪除照片（可復原）、設為封面、拆分站點、移到相鄰站點、與下一站合併
 */
export function StationCard({ station, stationIndex, prevStation, nextStation }: StationCardProps) {
  const photosMap = useJourneyStore((s) => s.journey.photos)
  const settings = useJourneyStore((s) => s.journey.settings)
  const coverPhotoId = useJourneyStore((s) => s.journey.coverPhotoId)
  const renameStation = useJourneyStore((s) => s.renameStation)
  const updateStationNote = useJourneyStore((s) => s.updateStationNote)
  const mergeWithNextStation = useJourneyStore((s) => s.mergeWithNextStation)
  const splitStationAtPhoto = useJourneyStore((s) => s.splitStationAtPhoto)
  const deleteStation = useJourneyStore((s) => s.deleteStation)
  const updatePhotoNote = useJourneyStore((s) => s.updatePhotoNote)
  const setCoverPhoto = useJourneyStore((s) => s.setCoverPhoto)
  const movePhotoToStation = useJourneyStore((s) => s.movePhotoToStation)
  const deletePhoto = useJourneyStore((s) => s.deletePhoto)
  const updateStationPages = useJourneyStore((s) => s.updateStationPages)

  const [selectedPhotoId, setSelectedPhotoId] = useState<string | null>(null)
  const [editingPageId, setEditingPageId] = useState<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [isDropTarget, setIsDropTarget] = useState(false)

  const pages = useMemo(() => resolveStationPages(station, photosMap, settings), [station, photosMap, settings])
  const flatIds = useMemo(() => pages.flatMap((p) => p.photoIds), [pages])

  // 與影片相同的規則決定每頁實際的樣式與運鏡（自動時顯示隨機結果）
  const resolvedStyles = useMemo(() => {
    let previous: PageMotion | undefined
    return pages.map((page) => {
      const included = page.photoIds.map((id) => photosMap[id]).filter((p): p is Photo => Boolean(p?.included))
      if (included.length === 0) return null
      const style = resolvePageStyle(page, included, settings, previous)
      previous = style.motion
      return { ...style, included }
    })
  }, [pages, photosMap, settings])

  const stationPhotos = flatIds.map((id) => photosMap[id]).filter((p): p is Photo => Boolean(p))
  const includedCount = stationPhotos.filter((p) => p.included).length
  const dateRange = formatDateRangeShort(stationPhotos.map((p) => p.localDate))
  const selectedPhoto = selectedPhotoId ? photosMap[selectedPhotoId] : undefined
  const selectedPhotoIndex = selectedPhotoId ? flatIds.indexOf(selectedPhotoId) : -1
  const editingIdx = editingPageId ? pages.findIndex((p) => p.id === editingPageId) : -1

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const savePages = (next: StationPage[]) => updateStationPages(station.id, next)

  const handleDragStart = (e: DragStartEvent) => setDraggingId(String(e.active.id))
  const handleDragEnd = (e: DragEndEvent) => {
    setDraggingId(null)
    const activeId = String(e.active.id)
    const overId = e.over ? String(e.over.id) : null
    if (!overId || overId === activeId) return
    const placeAfter = flatIds.indexOf(activeId) < flatIds.indexOf(overId)
    savePages(movePhotoInPages(pages, activeId, overId, placeAfter))
  }

  const handleStyleChange = (pageId: string, patch: { layout?: PageLayout | undefined; motion?: PageMotion | undefined }) => {
    savePages(updatePageStyle(pages, pageId, patch))
  }

  const commitName = () => {
    if (nameDraft === null) return
    const trimmed = nameDraft.trim()
    // 清空或跟自動地名一樣 → 回到自動地名
    renameStation(station.id, trimmed === '' || trimmed === station.autoName ? '' : nameDraft)
    setNameDraft(null)
  }

  const draggingPhoto = draggingId ? photosMap[draggingId] : undefined

  return (
    <div
      id={`station-card-${station.id}`}
      // 未歸類照片仍可用滑鼠直接拖進站點卡片（站內排序則由 dnd-kit 處理，兩者互不干擾）
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('text/plain')) return
        e.preventDefault()
        setIsDropTarget(true)
      }}
      onDragLeave={() => setIsDropTarget(false)}
      onDrop={(e) => {
        e.preventDefault()
        setIsDropTarget(false)
        const droppedId = e.dataTransfer.getData('text/plain')
        if (droppedId && photosMap[droppedId] && !station.photoIds.includes(droppedId)) {
          movePhotoToStation(droppedId, station.id)
        }
      }}
      className={`rounded-2xl border p-4 transition ${
        isDropTarget
          ? 'border-amber-400 bg-amber-500/10'
          : includedCount > 0
            ? 'border-slate-800 bg-slate-900/90'
            : 'border-slate-800/50 bg-slate-900/40 opacity-65'
      }`}
    >
      {/* 頂部：站點編號、名稱、日期範圍、刪除站點 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-[200px] flex-1 items-center gap-2.5">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-500 text-xs font-bold text-slate-950">
            {stationIndex + 1}
          </span>
          <input
            type="text"
            aria-label="站點名稱"
            value={nameDraft ?? getStationDisplayName(station)}
            onFocus={() => setNameDraft(getStationDisplayName(station))}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                setNameDraft(null)
                e.currentTarget.blur()
              }
            }}
            className="w-full rounded-lg border border-transparent bg-transparent px-2 py-1 text-base font-bold text-white hover:border-slate-700 focus:border-amber-500 focus:bg-slate-950 focus:outline-none"
          />
        </div>

        <div className="flex items-center gap-2 text-xs text-slate-400">
          {dateRange && <span className="rounded-md bg-slate-800 px-2 py-1 font-mono text-slate-300">{dateRange}</span>}
          <span>
            入選 {includedCount}/{stationPhotos.length} · {pages.length} 頁
          </span>
          <button
            type="button"
            title="刪除站點（將本站所有照片改為不入選）"
            onClick={() => deleteStation(station.id)}
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-500/15 hover:text-rose-400"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* 站點備註 */}
      <div className="mt-2.5">
        <input
          type="text"
          value={station.note ?? ''}
          onChange={(e) => updateStationNote(station.id, e.target.value)}
          placeholder="填寫站點備註（預設顯示於本站所有頁面左下角）…"
          className="w-full rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
        />
      </div>

      <p className="mt-3 text-[11px] text-slate-500">
        拖曳照片排序 · 點兩張照片之間的空隙加上或取消分隔線，分隔線之間的照片合成同一頁 · 點頁面下方的設定條調整拼接與運鏡
      </p>

      {/* 照片依頁分組 */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={() => setDraggingId(null)}>
        <SortableContext items={flatIds} strategy={rectSortingStrategy}>
          <div className="mt-2 flex flex-wrap items-start gap-y-3">
            {pages.map((page, pageIdx) => {
              const style = resolvedStyles[pageIdx]
              const prevPage = pageIdx > 0 ? pages[pageIdx - 1] : undefined
              return (
                <div key={page.id} className="flex max-w-full items-start">
                  {prevPage && (
                    <PageGapToggle
                      isBreak
                      onToggle={() =>
                        savePages(togglePageBreak(pages, prevPage.photoIds[prevPage.photoIds.length - 1], page.photoIds[0]))
                      }
                    />
                  )}
                  <div className="flex flex-col gap-1.5">
                    <div
                      className={`flex max-w-full flex-wrap items-center gap-y-1 rounded-2xl p-1.5 ${
                        page.photoIds.length > 1 ? 'bg-slate-800/70 ring-1 ring-slate-700' : 'bg-slate-800/30'
                      }`}
                    >
                      {page.photoIds.map((photoId, i) => {
                        const photo = photosMap[photoId]
                        if (!photo) return null
                        const prevId = i > 0 ? page.photoIds[i - 1] : undefined
                        return (
                          <div key={photoId} className="flex items-center">
                            {prevId && (
                              <PageGapToggle
                                isBreak={hasBreakBetween(pages, prevId, photoId)}
                                onToggle={() => savePages(togglePageBreak(pages, prevId, photoId))}
                              />
                            )}
                            <SortablePhotoThumb
                              photo={photo}
                              isCover={coverPhotoId === photoId}
                              isSelected={selectedPhotoId === photoId}
                              onSelect={() => setSelectedPhotoId((prev) => (prev === photoId ? null : photoId))}
                              onDelete={() => {
                                if (selectedPhotoId === photoId) setSelectedPhotoId(null)
                                deletePhoto(photoId)
                              }}
                            />
                          </div>
                        )
                      })}
                    </div>

                    {/* 頁面設定條 */}
                    <button
                      type="button"
                      disabled={!style}
                      onClick={() => setEditingPageId(page.id)}
                      title="設定這一頁的拼接樣式與鏡頭移動"
                      className="group/bar flex items-center gap-1.5 rounded-lg border-t-2 border-slate-700 px-1.5 pt-1 text-left text-[11px] text-slate-400 transition hover:border-amber-400 hover:text-amber-200 disabled:opacity-40"
                    >
                      {style ? (
                        <>
                          <span className="shrink-0 text-slate-500 group-hover/bar:text-amber-300">
                            <LayoutIcon layout={style.layout} count={style.included.length} landscape={settings.orientation === 'landscape'} />
                          </span>
                          <span className="min-w-0 leading-tight">
                            <span className="block truncate font-semibold text-slate-300">
                              {PAGE_LAYOUT_LABELS[style.layout]}
                              {!page.layout && style.included.length > 1 ? '・自動' : ''}
                            </span>
                            <span className="block truncate">
                              {describeMotion(style.motion)}
                              {!page.motion ? '・自動' : ''}
                            </span>
                          </span>
                          <Settings2 className="ml-auto h-3.5 w-3.5 shrink-0" />
                        </>
                      ) : (
                        <span>未入選</span>
                      )}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </SortableContext>
        <DragOverlay>
          {draggingPhoto ? (
            <div className="relative h-24 w-24 overflow-hidden rounded-xl border-2 border-amber-400 shadow-2xl">
              <PhotoThumbContent photo={draggingPhoto} isCover={coverPhotoId === draggingPhoto.id} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* 選取照片後的操作面板 */}
      {selectedPhoto && selectedPhotoIndex >= 0 && (
        <div className="mt-3 space-y-2.5 rounded-xl border border-slate-700/80 bg-slate-950 p-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="max-w-[200px] truncate font-medium text-amber-300">照片：{selectedPhoto.fileName}</span>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setCoverPhoto(selectedPhoto.id)}
                className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 font-medium transition ${
                  coverPhotoId === selectedPhoto.id ? 'bg-emerald-500 text-slate-950' : 'bg-slate-800 text-slate-200 hover:bg-slate-700'
                }`}
              >
                <Star className="h-3.5 w-3.5" />
                <span>{coverPhotoId === selectedPhoto.id ? '目前為封面' : '設為封面照片'}</span>
              </button>

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

              <button
                type="button"
                onClick={() => {
                  setSelectedPhotoId(null)
                  deletePhoto(selectedPhoto.id)
                }}
                className="inline-flex items-center gap-1 rounded-lg bg-rose-500/15 px-2.5 py-1 font-medium text-rose-300 hover:bg-rose-500/25"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>刪除照片</span>
              </button>
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

      {/* 與下一站合併 */}
      {nextStation && (
        <div className="mt-3 flex justify-center border-t border-slate-800/80 pt-2.5">
          <button
            type="button"
            onClick={() => mergeWithNextStation(station.id)}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-medium text-slate-400 transition hover:bg-slate-800 hover:text-amber-300"
          >
            <GitMerge className="h-3.5 w-3.5" />
            <span>與下一站「{getStationDisplayName(nextStation)}」合併</span>
          </button>
        </div>
      )}

      {editingIdx >= 0 && resolvedStyles[editingIdx] && (
        <PageStyleDialog
          page={pages[editingIdx]}
          photos={resolvedStyles[editingIdx]!.included}
          resolved={resolvedStyles[editingIdx]!}
          onChange={(patch) => handleStyleChange(pages[editingIdx].id, patch)}
          onClose={() => setEditingPageId(null)}
        />
      )}
    </div>
  )
}
