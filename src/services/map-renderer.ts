import { lineString } from '@turf/helpers'
import length from '@turf/length'
import lineSliceAlong from '@turf/line-slice-along'
import maplibregl, { type Map as MapLibreMap, type StyleSpecification } from 'maplibre-gl'
import defaultMapStyle from '../themes/default-map-style.json'
import { DEFAULT_VISUAL_THEME } from '../themes/default-theme'
import type { CameraState, Coordinates } from '../types/journey'

/**
 * 依據進度 (0 ~ 1) 截取折線座標（使用 @turf/line-slice-along）
 * NOTE: 路線經度可能已展開（超出 ±180，用於跨換日線），turf 以球面距離計算，不受影響
 * @param route 完整路線座標 [lng, lat][]
 * @param progress 進度 0 ~ 1
 * @returns 截取後的路線座標陣列
 */
export function sliceRouteByProgress(
  route: [number, number][],
  progress: number
): [number, number][] {
  if (route.length < 2 || progress <= 0) {
    return route.length > 0 ? [route[0], route[0]] : []
  }
  if (progress >= 1) {
    return route
  }

  try {
    const line = lineString(route)
    const totalKm = length(line, { units: 'kilometers' })
    if (totalKm <= 1e-5) {
      return [route[0], route[route.length - 1]]
    }
    const sliced = lineSliceAlong(line, 0, totalKm * progress, { units: 'kilometers' })
    const coords = sliced.geometry.coordinates.map((c) => [c[0], c[1]] as [number, number])
    return coords.length >= 2 ? coords : [route[0], route[0]]
  } catch {
    const idx = Math.max(1, Math.floor((route.length - 1) * progress))
    return route.slice(0, idx + 1)
  }
}

/** 地圖樣式（含字型、圖磚來源描述）載入的最長等待時間 */
const MAP_STYLE_LOAD_TIMEOUT_MS = 20000

/**
 * 等待地圖的下一個 data 事件或逾時（擇先發生者）
 */
function waitForMapEvent(map: MapLibreMap, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, timeoutMs)
    function done() {
      clearTimeout(timer)
      map.off('data', done)
      resolve()
    }
    map.once('data', done)
  })
}

/**
 * 封裝 MapLibre 實例，提供確定性運鏡（jumpTo + 同步 redraw）、螢幕座標投影與圖磚就緒等待
 * NOTE: 路線不放在 MapLibre 的 GeoJSON 圖層，而由 FramePainter 投影後以 Canvas 2D 繪製——
 * GeoJSON 每次 setData 都要等 Web Worker 重新切片，逐幀更新路線長度時會讓每一幀多等一輪
 * NOTE: 依據 ADR 0001：
 * - 不使用 flyTo，每一幀都由 cameraAt() 決定鏡頭，再以 jumpTo 定位
 * - 以 map.redraw() 同步繪製，確保擷取的地圖畫面與同一幀投影的標記位置一致
 * - pixelRatio 固定為 1：畫布尺寸即輸出尺寸，避免高 DPI 手機（DPR 3）把 1080p 地圖放大成 5760×3240
 */
export class DeterministicMapRenderer {
  private map: MapLibreMap | null = null
  private container: HTMLDivElement | null = null
  private isStyleLoaded = false
  /** 等待逾時、圖磚仍未到齊就繪製的幀數（網路不穩時用來提醒使用者） */
  incompleteFrameCount = 0

  /**
   * 初始化離屏或指定容器的 MapLibre 地圖實例
   * @param width 畫布寬度
   * @param height 畫布高度
   */
  async initialize(width: number, height: number): Promise<void> {
    this.destroy()

    const container = document.createElement('div')
    container.style.width = `${width}px`
    container.style.height = `${height}px`
    container.style.position = 'fixed'
    container.style.left = '-99999px'
    container.style.top = '0'
    container.style.pointerEvents = 'none'
    container.setAttribute('aria-hidden', 'true')
    document.body.appendChild(container)
    this.container = container

    const map = new maplibregl.Map({
      container,
      style: defaultMapStyle as unknown as StyleSpecification,
      center: [121.5, 25.0],
      zoom: 6,
      interactive: false,
      attributionControl: false, // 版權標示改由 FramePainter 繪入影片畫面
      fadeDuration: 0, // 停用符號淡入動畫，確保逐幀渲染確定性
      pixelRatio: 1,
      localIdeographFontFamily: DEFAULT_VISUAL_THEME.fontFamily,
      canvasContextAttributes: {
        preserveDrawingBuffer: true
      }
    })

    this.map = map

    // NOTE: 不等 'load' 事件——它由 MapLibre 的 requestAnimationFrame 觸發，分頁在背景時 rAF 會暫停，
    // 過去的做法是逾時後「當作沒載入」繼續跑，結果輸出整支沒有底圖的影片。
    // 改為主動同步 redraw() 推進載入流程，並在真的載入失敗時明確拋出錯誤
    const start = performance.now()
    while (!map.isStyleLoaded() && performance.now() - start < MAP_STYLE_LOAD_TIMEOUT_MS) {
      await waitForMapEvent(map, 50)
      if (this.map !== map) return // 等待期間已被 destroy()
      map.redraw()
    }

    if (!map.isStyleLoaded()) {
      this.destroy()
      throw new Error('地圖樣式載入失敗，請確認網路連線後再試一次。')
    }
    this.isStyleLoaded = true
  }

  /** 地圖樣式是否已載入完成 */
  get ready(): boolean {
    return this.isStyleLoaded
  }

  /**
   * 設定鏡頭狀態（使用 jumpTo 立即定位，不播放任何動畫）
   */
  setCamera(camera: CameraState): void {
    if (!this.map) return
    this.map.jumpTo({
      center: camera.center,
      zoom: camera.zoom,
      bearing: camera.bearing,
      pitch: camera.pitch
    })
  }

  /**
   * 將經緯度座標投影為當前畫布上的像素位置 (x, y)
   * NOTE: 會選擇最接近畫面中心的世界副本，避免跨換日線時標記投影到另一側
   */
  project(coords: Coordinates): { x: number; y: number } {
    if (!this.map) return { x: 0, y: 0 }
    const centerLng = this.map.getCenter().lng
    let lng = coords.longitude
    while (lng - centerLng > 180) lng -= 360
    while (lng - centerLng < -180) lng += 360
    const pt = this.map.project([lng, coords.latitude])
    return { x: pt.x, y: pt.y }
  }

  /**
   * 將一條（經度已展開的）路線投影成畫布像素座標。
   * 整條路線一起平移 360 度的倍數，使其落在最接近目前畫面中心的世界副本上
   */
  projectRoute(route: [number, number][]): { x: number; y: number }[] {
    if (!this.map || route.length === 0) return []
    const centerLng = this.map.getCenter().lng
    const midLng = route[Math.floor(route.length / 2)][0]
    const shift = Math.round((centerLng - midLng) / 360) * 360
    return route.map(([lng, lat]) => {
      const pt = this.map!.project([lng + shift, lat])
      return { x: pt.x, y: pt.y }
    })
  }

  /**
   * 同步繪製目前鏡頭的地圖畫面。
   * - waitForTiles = false（預覽）：立即同步繪製一次，圖磚未到齊時畫面可能暫時缺塊
   * - waitForTiles = true（輸出）：等待目前視野所需圖磚與路線資料全部就緒後再同步繪製
   * @param waitForTiles 是否等待圖磚就緒
   * @param timeoutMs 最長等待毫秒數（離線或伺服器緩慢時的保護）
   */
  async renderNow(waitForTiles: boolean, timeoutMs = 6000): Promise<void> {
    const map: MapLibreMap | null = this.map
    if (!map || !this.isStyleLoaded) return
    const activeMap: MapLibreMap = map

    // 第一次同步繪製：讓 MapLibre 依新鏡頭計算並發出所需圖磚請求
    map.redraw()
    if (!waitForTiles) return

    // NOTE: 等待期間每次都主動同步 redraw()，由我們驅動 MapLibre 更新圖磚狀態，
    // 不依賴它自己的 requestAnimationFrame（背景或被遮蔽的分頁 rAF 與計時器會被降頻到約每秒一次）
    const start = performance.now()
    while (!map.loaded() && performance.now() - start < timeoutMs) {
      await waitForMapEvent(activeMap, 16)
      map.redraw()
    }
    if (!map.loaded()) this.incompleteFrameCount += 1

    // 第二次同步繪製：所有圖磚已到齊，畫面完整
    map.redraw()
  }

  /**
   * 取得 MapLibre 的底層 WebGL Canvas 供繪入主畫布
   */
  getCanvas(): HTMLCanvasElement | null {
    return this.map ? this.map.getCanvas() : null
  }

  /**
   * 銷毀地圖實例並釋放 WebGL 與 DOM 資源
   */
  destroy(): void {
    if (this.map) {
      this.map.remove()
      this.map = null
    }
    if (this.container && this.container.parentElement) {
      this.container.parentElement.removeChild(this.container)
    }
    this.container = null
    this.isStyleLoaded = false
  }
}
