import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Car,
  Check,
  ChevronDown,
  ChevronUp,
  GitMerge,
  Loader2,
  MapPin,
  Plane,
  Plus,
  Search
} from 'lucide-react'
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type StyleSpecification } from 'maplibre-gl'
import { Fragment, useEffect, useRef, useState } from 'react'
import { computeFitBoundsCamera } from '../domain/camera-path'
import { calculateDistanceKm } from '../domain/station-clustering'
import { resolveLegRouteKind } from '../domain/timeline-builder'
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
    <button
      type="button"
      aria-pressed={isSelected}
      aria-label={`選取照片 ${photo.fileName}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', photo.id)
      }}
      onClick={() => onToggleSelect(photo.id)}
      className={`relative h-20 w-20 shrink-0 cursor-pointer overflow-hidden rounded-xl border-2 text-left transition focus:outline-none focus:ring-2 focus:ring-amber-400 ${
        isSelected
          ? 'border-amber-400 ring-2 ring-amber-400/40'
          : 'border-slate-700 hover:border-slate-500'
      }`}
    >
      {url ? (
        <img src={url} alt={photo.fileName} draggable={false} className="h-full w-full object-cover" />
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
    </button>
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
  const mergeWithNextStation = useJourneyStore((s) => s.mergeWithNextStation)
  const setStationArrivalRouteKind = useJourneyStore((s) => s.setStationArrivalRouteKind)
  const createManualStationWithPhotos = useJourneyStore(
    (s) => s.createManualStationWithPhotos
  )
  const summary = useJourneySummary()

  const mapContainerRef = useRef<HTMLDivElement | null>(null)
  const mapInstanceRef = useRef<MapLibreMap | null>(null)
  const markersRef = useRef<maplibregl.Marker[]>([])
  const pickedMarkerRef = useRef<maplibregl.Marker | null>(null)
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastFitKeyRef = useRef('')

  // 獨立拆分「手動建立站點」與「未歸類照片區」的批次選取狀態，避免互相干擾
  const [manualModalPhotoIds, setManualModalPhotoIds] = useState<string[]>([])
  const [unassignedSelectedIds, setUnassignedSelectedIds] = useState<string[]>([])
  const [showManualStationModal, setShowManualStationModal] = useState(false)
  const [placeQuery, setPlaceQuery] = useState('')
  const [isSearchingPlace, setIsSearchingPlace] = useState(false)
  const [searchResults, setSearchResults] = useState<PlaceSearchResult[]>([])
  const [pickedCoords, setPickedCoords] = useState<Coordinates | null>(null)
  const [manualStationName, setManualStationName] = useState('')
  const [targetStationForUnassigned, setTargetStationForUnassigned] = useState<string>('')
  const [highlightedStationId, setHighlightedStationId] = useState<string | null>(null)
  // 地圖點擊只在「手動建立站點」面板開啟時才用來選座標（地圖初始化時註冊的事件透過 ref 讀取最新狀態）
  const isPickingLocationRef = useRef(false)
  isPickingLocationRef.current = showManualStationModal
  const [isMobileMapCollapsed, setIsMobileMapCollapsed] = useState(false)

  const toggleManualModalPhoto = (id: string) => {
    setManualModalPhotoIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }

  const toggleUnassignedPhoto = (id: string) => {
    setUnassignedSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }

  const highlightStationCard = (stationId: string) => {
    setHighlightedStationId(stationId)
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    highlightTimerRef.current = setTimeout(() => {
      setHighlightedStationId(null)
    }, 1800)
  }

  const focusMapOnStation = (coords: Coordinates) => {
    const map = mapInstanceRef.current
    if (!map) return
    if (isMobileMapCollapsed) setIsMobileMapCollapsed(false)
    map.easeTo({
      center: [coords.longitude, coords.latitude],
      zoom: Math.max(map.getZoom(), 9),
      duration: 500
    })
  }

  useEffect(
    () => () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    },
    []
  )

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
        id: 'overview-route-ground',
        type: 'line',
        source: 'overview-route',
        filter: ['!=', ['get', 'routeKind'], 'flight'],
        layout: {
          'line-cap': 'round',
          'line-join': 'round'
        },
        paint: {
          'line-color': '#3B82F6',
          'line-width': 4
        }
      })

      map.addLayer({
        id: 'overview-route-flight',
        type: 'line',
        source: 'overview-route',
        filter: ['==', ['get', 'routeKind'], 'flight'],
        layout: {
          'line-cap': 'round',
          'line-join': 'round'
        },
        paint: {
          'line-color': '#F59E0B',
          'line-width': 3.5,
          'line-dasharray': [2, 2]
        }
      })
    })

    // 支援在地圖上點選位置作為手動建立站點的座標
    map.on('click', (e) => {
      if (!isPickingLocationRef.current) return
      setPickedCoords({
        latitude: Number(e.lngLat.lat.toFixed(5)),
        longitude: Number(e.lngLat.lng.toFixed(5))
      })
    })

    mapInstanceRef.current = map

    return () => {
      pickedMarkerRef.current?.remove()
      pickedMarkerRef.current = null
      markersRef.current.forEach((m) => m.remove())
      markersRef.current = []
      map.remove()
      mapInstanceRef.current = null
      // 地圖重建後需要重新框住站點
      lastFitKeyRef.current = ''
    }
  }, [])

  // 在地圖上顯示使用者點擊或搜尋選取的臨時座標圖釘
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map) return
    pickedMarkerRef.current?.remove()
    pickedMarkerRef.current = null
    if (!pickedCoords) return

    const el = document.createElement('div')
    el.className =
      'flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-emerald-500 text-slate-950 shadow-lg ring-4 ring-emerald-400/35'
    el.innerHTML =
      '<span class="h-2.5 w-2.5 rounded-full bg-slate-950"></span>'

    const marker = new maplibregl.Marker({ element: el, draggable: true })
      .setLngLat([pickedCoords.longitude, pickedCoords.latitude])
      .addTo(map)
    marker.on('dragend', () => {
      const lngLat = marker.getLngLat()
      setPickedCoords({
        latitude: Number(lngLat.lat.toFixed(5)),
        longitude: Number(lngLat.lng.toFixed(5))
      })
    })
    pickedMarkerRef.current = marker
  }, [pickedCoords])

  // 關閉「手動建立站點」面板（取消、關閉或建立完成）時一併清除地圖上的暫時圖釘
  useEffect(() => {
    if (!showManualStationModal) setPickedCoords(null)
  }, [showManualStationModal])

  // 手機收合地圖重新展開時通知 MapLibre 更新畫布尺寸
  useEffect(() => {
    if (!isMobileMapCollapsed) {
      mapInstanceRef.current?.resize()
    }
  }, [isMobileMapCollapsed])

  // 同步站點標記與路線到小地圖
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map) return

    // 清除舊標記
    markersRef.current.forEach((m) => m.remove())
    markersRef.current = []

    const stations = journey.stations
    stations.forEach((st, idx) => {
      const hasIncluded = st.photoIds.some((id) => journey.photos[id]?.included)
      const el = document.createElement('button')
      el.type = 'button'
      el.className = hasIncluded
        ? 'flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-amber-400 text-xs font-bold text-slate-950 shadow-md transition hover:scale-110'
        : 'flex h-7 w-7 items-center justify-center rounded-full border-2 border-slate-300/60 bg-slate-700/85 text-xs font-bold text-slate-300 opacity-65 shadow transition hover:scale-110'
      el.textContent = String(idx + 1)
      el.title = `${getStationDisplayName(st)}${hasIncluded ? '' : '（無入選照片）'}`
      el.setAttribute('aria-label', `跳至站點 ${idx + 1}：${getStationDisplayName(st)}`)
      el.onclick = (ev) => {
        ev.stopPropagation()
        const card = document.getElementById(`station-card-${st.id}`)
        card?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        highlightStationCard(st.id)
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

    // 更新路線（區分飛行虛線與陸路實線）
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
          properties: { routeKind: seg.routeKind },
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
  }, [journey.stations, journey.photos, summary.timeline])

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
    if (!pickedCoords || manualModalPhotoIds.length === 0) return
    createManualStationWithPhotos(
      manualStationName || '自訂站點',
      pickedCoords,
      manualModalPhotoIds
    )
    setManualModalPhotoIds([])
    setPickedCoords(null)
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
                          focusMapOnStation(res.coordinates)
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
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="font-medium text-slate-300">
                    2. 點選要歸入此位置的照片（已選 {manualModalPhotoIds.length} 張）
                  </label>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() =>
                        setManualModalPhotoIds(allMissingLocationPhotos.map((p) => p.id))
                      }
                      className="text-amber-400 hover:underline"
                    >
                      全選缺定位照片
                    </button>
                    {manualModalPhotoIds.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setManualModalPhotoIds([])}
                        className="text-slate-400 hover:underline"
                      >
                        取消全選
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 overflow-x-auto pb-2">
                  {allMissingLocationPhotos.map((p) => (
                    <UnassignedPhotoThumb
                      key={p.id}
                      photo={p}
                      isSelected={manualModalPhotoIds.includes(p.id)}
                      onToggleSelect={toggleManualModalPhoto}
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
                  disabled={!pickedCoords || manualModalPhotoIds.length === 0}
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
          <div className="sticky top-20 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-lg">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-2.5 text-xs text-slate-300">
              <div className="flex items-center gap-2">
                <span className="font-semibold">旅程路線預覽地圖</span>
                <span className="hidden items-center gap-2 text-[11px] text-slate-400 sm:inline-flex">
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-0.5 w-3 bg-blue-500" />陸路
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block w-3 border-t-2 border-dashed border-amber-400" />飛行
                  </span>
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="hidden text-slate-400 lg:inline">點擊標記捲動至對應站點</span>
                <button
                  type="button"
                  aria-expanded={!isMobileMapCollapsed}
                  onClick={() => setIsMobileMapCollapsed((v) => !v)}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] font-medium text-slate-200 lg:hidden"
                >
                  {isMobileMapCollapsed ? (
                    <>
                      <span>展開地圖</span>
                      <ChevronDown className="h-3.5 w-3.5" />
                    </>
                  ) : (
                    <>
                      <span>收合地圖</span>
                      <ChevronUp className="h-3.5 w-3.5" />
                    </>
                  )}
                </button>
              </div>
            </div>
            <div
              ref={mapContainerRef}
              className={`w-full bg-slate-950 transition-all ${
                isMobileMapCollapsed ? 'hidden lg:block lg:h-[480px]' : 'h-56 sm:h-72 lg:h-[480px]'
              }`}
            />
          </div>
        </div>

        {/* 站點卡片列表（永遠依時間排列，不可手動調整站點順序） */}
        <div className="space-y-3 lg:col-span-7">
          {journey.stations.length > 0 && (
            <p className="rounded-xl border border-slate-800/80 bg-slate-900/60 px-3.5 py-2 text-xs text-slate-400">
              提示：拖曳照片可調整順序；點擊照片之間的空隙可加上或取消分隔線，分隔線之間的照片將合成同一頁；點擊頁面下方設定條可調整拼接與運鏡；雙擊照片可放大檢視。
            </p>
          )}
          {journey.stations.length === 0 ? (
            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-8 text-center text-sm text-slate-400">
              目前尚無有定位的站點。請使用上方「手動建立站點」將未歸類照片指定位置。
            </div>
          ) : (
            journey.stations.map((st, idx) => {
              const nextSt = idx < journey.stations.length - 1 ? journey.stations[idx + 1] : undefined
              const distKm = nextSt ? calculateDistanceKm(st.center, nextSt.center) : 0
              const routeKind = nextSt
                ? resolveLegRouteKind(st, nextSt, journey.settings.longDistanceThresholdKm)
                : 'ground'

              return (
                <Fragment key={st.id}>
                  <StationCard
                    station={st}
                    stationIndex={idx}
                    totalStations={journey.stations.length}
                    prevStation={idx > 0 ? journey.stations[idx - 1] : undefined}
                    nextStation={nextSt}
                    allStations={journey.stations}
                    isHighlighted={highlightedStationId === st.id}
                    hideInlineMerge
                    onFocusOnMap={() => focusMapOnStation(st.center)}
                  />

                  {nextSt && (
                    <div className="relative flex items-center justify-center py-1">
                      <div className="absolute inset-x-6 top-1/2 -z-0 border-t border-dashed border-slate-800" aria-hidden="true" />
                      <div className="relative z-10 flex flex-wrap items-center justify-center gap-2 rounded-full border border-slate-800 bg-slate-950 px-3 py-1 text-xs shadow">
                        {/* 交通方式：自動依長途門檻判斷，也可手動指定（例如長途高鐵仍是陸路） */}
                        <label
                          className={`inline-flex items-center gap-1 font-medium ${
                            routeKind === 'flight' ? 'text-amber-300' : 'text-sky-300'
                          }`}
                        >
                          {routeKind === 'flight' ? (
                            <Plane className="h-3.5 w-3.5" />
                          ) : (
                            <Car className="h-3.5 w-3.5" />
                          )}
                          <span className="relative inline-flex items-center">
                          <select
                            aria-label={`從「${getStationDisplayName(st)}」到「${getStationDisplayName(nextSt)}」的交通方式`}
                            value={nextSt.arrivalRouteKind ?? 'auto'}
                            onChange={(e) =>
                              setStationArrivalRouteKind(
                                nextSt.id,
                                e.target.value === 'auto' ? undefined : (e.target.value as 'ground' | 'flight')
                              )
                            }
                            className="cursor-pointer appearance-none rounded-md bg-transparent pr-3 font-medium focus:outline-none focus:ring-1 focus:ring-amber-400"
                          >
                            <option value="auto">
                              自動（
                              {resolveLegRouteKind(st, { center: nextSt.center }, journey.settings.longDistanceThresholdKm) === 'flight'
                                ? '飛行'
                                : '陸路'}
                              ）
                            </option>
                            <option value="ground">陸路（開車、高鐵、火車）</option>
                            <option value="flight">飛行</option>
                          </select>
                          <ChevronDown className="pointer-events-none absolute right-0 h-3 w-3 opacity-70" />
                          </span>
                          <span>{Math.round(distKm).toLocaleString()} km</span>
                        </label>
                        <span className="text-slate-700" aria-hidden="true">|</span>
                        <button
                          type="button"
                          onClick={() => mergeWithNextStation(st.id)}
                          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium text-slate-300 transition hover:bg-slate-800 hover:text-amber-300"
                        >
                          <GitMerge className="h-3.5 w-3.5" />
                          <span>與「{getStationDisplayName(nextSt)}」合併</span>
                        </button>
                      </div>
                    </div>
                  )}
                </Fragment>
              )
            })
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
                這些照片既無定位也無拍攝時間。您可以點選照片後移入指定站點<span className="[@media(hover:none)]:hidden">（或直接拖入上方站點卡片）</span>；未放入站點的照片不會出現在影片中。
              </p>
            </div>

            {journey.stations.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <button
                  type="button"
                  onClick={() =>
                    setUnassignedSelectedIds(
                      unassignedSelectedIds.length === unassignedPhotos.length
                        ? []
                        : unassignedPhotos.map((p) => p.id)
                    )
                  }
                  className="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-slate-300 hover:bg-slate-800"
                >
                  {unassignedSelectedIds.length === unassignedPhotos.length ? '取消全選' : '全選未歸類'}
                </button>
                <select
                  aria-label="選擇目標站點"
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
                  disabled={unassignedSelectedIds.length === 0}
                  onClick={() => {
                    const destId =
                      targetStationForUnassigned || journey.stations[0]?.id
                    if (!destId) return
                    for (const pid of unassignedSelectedIds) {
                      movePhotoToStation(pid, destId)
                    }
                    setUnassignedSelectedIds([])
                  }}
                  className="rounded-lg bg-amber-500 px-3 py-1.5 font-semibold text-slate-950 disabled:opacity-40"
                >
                  將已選 {unassignedSelectedIds.length > 0 ? `${unassignedSelectedIds.length} 張` : ''}照片移入該站
                </button>
              </div>
            )}
          </div>

          <div className="flex gap-2.5 overflow-x-auto pb-2">
            {unassignedPhotos.map((p) => (
              <UnassignedPhotoThumb
                key={p.id}
                photo={p}
                isSelected={unassignedSelectedIds.includes(p.id)}
                onToggleSelect={toggleUnassignedPhoto}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
