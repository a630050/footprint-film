import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  MapPin,
  Plus,
  Search
} from 'lucide-react'
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type StyleSpecification } from 'maplibre-gl'
import { useEffect, useRef, useState } from 'react'
import { computeFitBoundsCamera } from '../domain/camera-path'
import { useJourneySummary } from '../hooks/use-journey-summary'
import { usePhotoObjectUrl } from '../hooks/use-photo-object-url'
import { getStationDisplayName } from '../services/frame-painter'
import { searchPlaceByName, type PlaceSearchResult } from '../services/geocoding'
import { useJourneyStore } from '../store/journey-store'
import defaultMapStyle from '../themes/default-map-style.json'
import type { Coordinates, Photo, Segment } from '../types/journey'
import { SettingsPanel } from './SettingsPanel'
import { StationCard } from './StationCard'

interface UnassignedThumbProps {
  photo: Photo
  isSelected: boolean
  onToggleSelect: (id: string) => void
}

function UnassignedPhotoThumb({
  photo,
  isSelected,
  onToggleSelect
}: UnassignedThumbProps) {
  const url = usePhotoObjectUrl(photo.imageBlob)

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', photo.id)
      }}
      onClick={() => onToggleSelect(photo.id)}
      className={`relative h-20 w-20 shrink-0 cursor-pointer overflow-hidden rounded-xl border-2 transition ${
        isSelected
          ? 'border-amber-400 ring-2 ring-amber-400/40'
          : 'border-slate-700 hover:border-slate-500'
      }`}
    >
      {url ? (
        <img src={url} alt={photo.fileName} className="h-full w-full object-cover" />
      ) : (
        <div className="h-full w-full bg-slate-800" />
      )}
      <span
        className={`absolute top-1 left-1 flex h-4 w-4 items-center justify-center rounded border text-[10px] ${
          isSelected
            ? 'border-amber-400 bg-amber-500 text-slate-950'
            : 'border-white/50 bg-black/60 text-transparent'
        }`}
      >
        <Check className="h-3 w-3 stroke-[3]" />
      </span>
    </div>
  )
}

/**
 * 步驟 ②：編輯旅程元件 (§4.3)
 * - 手機：上方小地圖＋下方站點卡片列表，上下排列
 * - 電腦：左側地圖、右側站點卡片並排
 * - 最下方為未歸類照片區
 * - 超過一半照片無定位時，頂部顯示重新選取的引導，並提供「手動建立站點」（地名搜尋或地圖點選）與「選取多張照片批次指定位置」
 */
export function JourneyEditor() {
  const journey = useJourneyStore((s) => s.journey)
  const geocodingProgress = useJourneyStore((s) => s.geocodingProgress)
  const setCurrentStep = useJourneyStore((s) => s.setCurrentStep)
  const movePhotoToStation = useJourneyStore((s) => s.movePhotoToStation)
  const createManualStationWithPhotos = useJourneyStore(
    (s) => s.createManualStationWithPhotos
  )
  const summary = useJourneySummary()

  const mapContainerRef = useRef<HTMLDivElement | null>(null)
  const mapInstanceRef = useRef<MapLibreMap | null>(null)
  const markersRef = useRef<maplibregl.Marker[]>([])
  const lastFitKeyRef = useRef('')

  // 手動建立站點與批次指定位置狀態
  const [selectedBatchPhotoIds, setSelectedBatchPhotoIds] = useState<string[]>([])
  const [showManualStationModal, setShowManualStationModal] = useState(false)
  const [placeQuery, setPlaceQuery] = useState('')
  const [isSearchingPlace, setIsSearchingPlace] = useState(false)
  const [searchResults, setSearchResults] = useState<PlaceSearchResult[]>([])
  const [pickedCoords, setPickedCoords] = useState<Coordinates | null>(null)
  const [manualStationName, setManualStationName] = useState('')
  const [targetStationForUnassigned, setTargetStationForUnassigned] = useState<string>('')

  const toggleBatchPhoto = (id: string) => {
    setSelectedBatchPhotoIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }

  // 初始化互動小地圖
  useEffect(() => {
    const container = mapContainerRef.current
    if (!container) return

    const map = new maplibregl.Map({
      container,
      style: defaultMapStyle as unknown as StyleSpecification,
      center: [121.5, 25.0],
      zoom: 6,
      attributionControl: { compact: true }
    })

    map.on('load', () => {
      map.addSource('overview-route', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: []
        }
      })

      map.addLayer({
        id: 'overview-route-line',
        type: 'line',
        source: 'overview-route',
        layout: {
          'line-cap': 'round',
          'line-join': 'round'
        },
        paint: {
          'line-color': '#3B82F6',
          'line-width': 4
        }
      })
    })

    // 支援在地圖上點選位置作為手動建立站點的座標
    map.on('click', (e) => {
      setPickedCoords({
        latitude: Number(e.lngLat.lat.toFixed(5)),
        longitude: Number(e.lngLat.lng.toFixed(5))
      })
    })

    mapInstanceRef.current = map

    return () => {
      markersRef.current.forEach((m) => m.remove())
      markersRef.current = []
      map.remove()
      mapInstanceRef.current = null
      // 地圖重建後需要重新框住站點
      lastFitKeyRef.current = ''
    }
  }, [])

  // 同步站點標記與路線到小地圖
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map) return

    // 清除舊標記
    markersRef.current.forEach((m) => m.remove())
    markersRef.current = []

    const stations = journey.stations
    stations.forEach((st, idx) => {
      const el = document.createElement('button')
      el.type = 'button'
      el.className =
        'flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-amber-400 text-xs font-bold text-slate-950 shadow-md transition hover:scale-110'
      el.textContent = String(idx + 1)
      el.title = getStationDisplayName(st)
      el.onclick = (ev) => {
        ev.stopPropagation()
        const card = document.getElementById(`station-card-${st.id}`)
        card?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }

      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([st.center.longitude, st.center.latitude])
        .addTo(map)
      markersRef.current.push(marker)
    })

    // 只在站點位置組合改變時才重新框住所有站點（輸入備註、改名時不打斷使用者自己拖動的地圖）
    const fitKey = stations
      .map((st) => `${st.center.latitude.toFixed(4)},${st.center.longitude.toFixed(4)}`)
      .join('|')
    if (stations.length > 0 && fitKey !== lastFitKeyRef.current) {
      lastFitKeyRef.current = fitKey
      const fit = computeFitBoundsCamera(
        stations.map((s) => s.center),
        {
          width: map.getContainer().clientWidth || 640,
          height: map.getContainer().clientHeight || 400
        },
        10
      )
      map.jumpTo({ center: fit.center, zoom: fit.zoom })
    }

    // 更新路線
    const updateRouteSource = () => {
      const src = map.getSource('overview-route') as GeoJSONSource | undefined
      if (!src) return
      const moveSegments = summary.timeline.filter(
        (s): s is Extract<Segment, { type: 'MOVE' }> => s.type === 'MOVE'
      )
      src.setData({
        type: 'FeatureCollection',
        features: moveSegments.map((seg) => ({
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: seg.route
          }
        }))
      })
    }

    // NOTE: 不用 isStyleLoaded() 判斷——圖磚載入中它可能回傳 false，而 'load' 事件早已觸發過，
    // 改等 'load' 會永遠等不到。直接看路線來源是否已建立即可
    if (map.getSource('overview-route')) {
      updateRouteSource()
    } else {
      map.once('load', updateRouteSource)
    }
  }, [journey.stations, summary.timeline])

  const handlePlaceSearch = async () => {
    if (!placeQuery.trim()) return
    setIsSearchingPlace(true)
    try {
      const results = await searchPlaceByName(placeQuery)
      setSearchResults(results)
    } finally {
      setIsSearchingPlace(false)
    }
  }

  const handleCreateManualStation = () => {
    if (!pickedCoords || selectedBatchPhotoIds.length === 0) return
    createManualStationWithPhotos(
      manualStationName || '自訂站點',
      pickedCoords,
      selectedBatchPhotoIds
    )
    setSelectedBatchPhotoIds([])
    setShowManualStationModal(false)
    setManualStationName('')
  }

  const unassignedPhotos = journey.unassignedPhotoIds
    .map((id) => journey.photos[id])
    .filter((p): p is Photo => Boolean(p))

  const allMissingLocationPhotos = Object.values(journey.photos).filter(
    (p) => p.locationSource === 'none' || p.locationSource === 'inferred'
  )

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-4 py-5">
      {/* 頂部導覽與預估影片長度 */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/90 px-4 py-3">
        <button
          type="button"
          onClick={() => setCurrentStep(1)}
          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700 transition"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>步驟 ① 加選照片</span>
        </button>

        <div className="flex items-center gap-4 text-xs">
          {geocodingProgress.isQuerying && (
            <span className="inline-flex items-center gap-1.5 text-amber-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>
                查詢站點地名中（{geocodingProgress.completed}/{geocodingProgress.total}）
              </span>
            </span>
          )}
          <div className="rounded-lg bg-slate-950 px-3 py-1.5 text-slate-300 border border-slate-800">
            預估影片長度：
            <strong className="ml-1 text-amber-400">{summary.formattedDuration}</strong>
          </div>
        </div>

        <button
          type="button"
          disabled={summary.timeline.length === 0}
          onClick={() => setCurrentStep(3)}
          className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-4 py-2 text-xs font-bold text-slate-950 shadow-md shadow-amber-500/20 hover:bg-amber-400 disabled:opacity-40 transition"
        >
          <span>下一步：預覽與輸出</span>
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>

      {/* 超過一半照片沒有定位時的頂部引導與手動建立站點入口 (§4.1) */}
      {(summary.isMoreThanHalfMissingLocation || journey.unassignedPhotoIds.length > 0) && (
        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 space-y-3 text-xs text-amber-100">
          {summary.isMoreThanHalfMissingLocation && (
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
              <div>
                <p className="font-semibold text-amber-300">
                  超過一半的照片沒有 GPS 定位資訊
                </p>
                <p className="mt-0.5 text-amber-200/80">
                  若您使用手機選取照片，可在選照片畫面點選「選項 → 開啟位置」後重新選取；或直接在此手動建立站點並批次指定照片位置。
                </p>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowManualStationModal((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-3.5 py-2 font-semibold text-slate-950 hover:bg-amber-400 transition"
            >
              <Plus className="h-4 w-4" />
              <span>手動建立站點 / 批次指定照片位置</span>
            </button>
          </div>

          {showManualStationModal && (
            <div className="rounded-xl border border-slate-700 bg-slate-950 p-4 space-y-4 text-slate-200">
              <h4 className="font-bold text-sm text-white">
                手動建立站點並批次指定照片位置
              </h4>

              {/* 步驟 A：搜尋地名或點擊地圖 */}
              <div className="space-y-2">
                <label className="block font-medium text-slate-300">
                  1. 搜尋地名（或直接點擊下方／左側小地圖選取座標）
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={placeQuery}
                    onChange={(e) => setPlaceQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handlePlaceSearch()}
                    placeholder="輸入城市或景點名稱，例如：東京鐵塔、日月潭…"
                    className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-white focus:border-amber-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={isSearchingPlace}
                    onClick={handlePlaceSearch}
                    className="inline-flex items-center gap-1 rounded-lg bg-slate-800 px-3 py-1.5 font-medium text-slate-200 hover:bg-slate-700"
                  >
                    {isSearchingPlace ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Search className="h-3.5 w-3.5" />
                    )}
                    <span>搜尋</span>
                  </button>
                </div>

                {searchResults.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {searchResults.map((res, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => {
                          setPickedCoords(res.coordinates)
                          setManualStationName(res.shortName)
                        }}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1 text-left text-[11px] text-slate-200 hover:border-amber-400"
                      >
                        <MapPin className="h-3 w-3 text-amber-400 shrink-0" />
                        <span className="truncate max-w-[240px]">{res.displayName}</span>
                      </button>
                    ))}
                  </div>
                )}

                {pickedCoords && (
                  <div className="flex flex-wrap items-center gap-3 pt-1">
                    <span className="text-emerald-400 font-mono">
                      已選座標：{pickedCoords.latitude}, {pickedCoords.longitude}
                    </span>
                    <input
                      type="text"
                      value={manualStationName}
                      onChange={(e) => setManualStationName(e.target.value)}
                      placeholder="站點名稱（如：信義區 · 台北市）"
                      className="rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs text-white"
                    />
                  </div>
                )}
              </div>

              {/* 步驟 B：多選無定位／未歸類照片 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="font-medium text-slate-300">
                    2. 點選要歸入此位置的照片（已選 {selectedBatchPhotoIds.length} 張）
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedBatchPhotoIds(allMissingLocationPhotos.map((p) => p.id))
                    }
                    className="text-amber-400 hover:underline"
                  >
                    全選缺定位照片
                  </button>
                </div>
                <div className="flex gap-2 overflow-x-auto pb-2">
                  {allMissingLocationPhotos.map((p) => (
                    <UnassignedPhotoThumb
                      key={p.id}
                      photo={p}
                      isSelected={selectedBatchPhotoIds.includes(p.id)}
                      onToggleSelect={toggleBatchPhoto}
                    />
                  ))}
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowManualStationModal(false)}
                  className="rounded-lg border border-slate-700 px-3 py-1.5 text-slate-300"
                >
                  關閉
                </button>
                <button
                  type="button"
                  disabled={!pickedCoords || selectedBatchPhotoIds.length === 0}
                  onClick={handleCreateManualStation}
                  className="rounded-lg bg-emerald-500 px-4 py-1.5 font-semibold text-slate-950 disabled:opacity-40"
                >
                  建立站點並套用位置
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 可收合設定區 */}
      <SettingsPanel />

      {/* 主版面：手機上下排列（上方小地圖 + 下方站點卡片），桌機左右並排 */}
      <div className="grid gap-5 lg:grid-cols-12">
        {/* 小地圖區 */}
        <div className="lg:col-span-5">
          <div className="sticky top-4 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-lg">
            <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5 text-xs text-slate-300">
              <span className="font-semibold">旅程路線預覽地圖</span>
              <span className="text-slate-400">點擊標記捲動至對應站點</span>
            </div>
            <div
              ref={mapContainerRef}
              className="h-64 w-full sm:h-80 lg:h-[480px] bg-slate-950"
            />
          </div>
        </div>

        {/* 站點卡片列表（永遠依時間排列，不可手動調整站點順序） */}
        <div className="space-y-4 lg:col-span-7">
          {journey.stations.length === 0 ? (
            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-8 text-center text-sm text-slate-400">
              目前尚無有定位的站點。請使用上方「手動建立站點」將未歸類照片指定位置。
            </div>
          ) : (
            journey.stations.map((st, idx) => (
              <StationCard
                key={st.id}
                station={st}
                stationIndex={idx}
                totalStations={journey.stations.length}
                prevStation={idx > 0 ? journey.stations[idx - 1] : undefined}
                nextStation={
                  idx < journey.stations.length - 1 ? journey.stations[idx + 1] : undefined
                }
              />
            ))
          )}
        </div>
      </div>

      {/* 最下方：未歸類照片區 (§4.1 & §4.3) */}
      {unassignedPhotos.length > 0 && (
        <div className="rounded-2xl border border-rose-500/30 bg-slate-900/95 p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-bold text-rose-300">
                未歸類照片（{unassignedPhotos.length} 張）
              </h3>
              <p className="text-xs text-slate-400">
                這些照片既無定位也無拍攝時間。您可以直接將照片拖入上方任一站點卡片，或勾選後移入指定站點；未放入站點的照片不會出現在影片中。
              </p>
            </div>

            {journey.stations.length > 0 && (
              <div className="flex items-center gap-2 text-xs">
                <select
                  value={targetStationForUnassigned || journey.stations[0]?.id || ''}
                  onChange={(e) => setTargetStationForUnassigned(e.target.value)}
                  className="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-slate-200"
                >
                  {journey.stations.map((st, i) => (
                    <option key={st.id} value={st.id}>
                      站點 {i + 1}：{getStationDisplayName(st)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={selectedBatchPhotoIds.length === 0}
                  onClick={() => {
                    const destId =
                      targetStationForUnassigned || journey.stations[0]?.id
                    if (!destId) return
                    for (const pid of selectedBatchPhotoIds) {
                      movePhotoToStation(pid, destId)
                    }
                    setSelectedBatchPhotoIds([])
                  }}
                  className="rounded-lg bg-amber-500 px-3 py-1.5 font-semibold text-slate-950 disabled:opacity-40"
                >
                  將勾選照片移入該站
                </button>
              </div>
            )}
          </div>

          <div className="flex gap-2.5 overflow-x-auto pb-2">
            {unassignedPhotos.map((p) => (
              <UnassignedPhotoThumb
                key={p.id}
                photo={p}
                isSelected={selectedBatchPhotoIds.includes(p.id)}
                onToggleSelect={toggleBatchPhoto}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
