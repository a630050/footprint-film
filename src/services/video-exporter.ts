import {
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output
} from 'mediabunny'
import { getVideoDimensions, VIDEO_FPS } from '../constants/video-config'
import { cameraAt } from '../domain/camera-path'
import { calculateTotalDurationMs } from '../domain/timeline-builder'
import type { Journey, Segment, VideoOrientation, VideoResolution } from '../types/journey'
import { FramePainter, getActiveStations } from './frame-painter'
import { isWebCodecsSupported } from './browser-support'
import { DeterministicMapRenderer } from './map-renderer'

/** H.264 候選設定檔（由高相容 Baseline / Main 到 High 依序探測） */
const H264_CODEC_CANDIDATES = [
  'avc1.640028', // High Profile Level 4.0
  'avc1.4d0028', // Main Profile Level 4.0
  'avc1.420028', // Baseline Profile Level 4.0
  'avc1.42E01F'  // Constrained Baseline Level 3.1
]

export { isWebCodecsSupported }

export interface SupportedEncoderSelection {
  codec: string
  resolution: VideoResolution
  width: number
  height: number
  bitrate: number
  downgradedTo720p: boolean
}

/**
 * 依據規格書 §3 以 `VideoEncoder.isConfigSupported` 檢查是否支援所選解析度（預設 1080p），
 * 若不支援 1080p 則自動改用 720p 並回傳 downgradedTo720p = true 供介面告知使用者
 * @param orientation 影片方向
 * @param preferredResolution 使用者選擇的解析度
 */
export async function probeSupportedH264Config(
  orientation: VideoOrientation,
  preferredResolution: VideoResolution
): Promise<SupportedEncoderSelection> {
  const resolutionsToTry: VideoResolution[] =
    preferredResolution === '1080p' ? ['1080p', '720p'] : ['720p']

  for (const res of resolutionsToTry) {
    const { width, height } = getVideoDimensions(orientation, res)
    // 畫面多為緩慢放大的照片與地圖，6Mbps 已足夠清晰，並讓 2~3 分鐘影片維持在約 100MB 內，方便分享
    const bitrate = res === '1080p' ? 6_000_000 : 3_500_000

    for (const codec of H264_CODEC_CANDIDATES) {
      try {
        const support = await VideoEncoder.isConfigSupported({
          codec,
          width,
          height,
          bitrate,
          framerate: VIDEO_FPS
        })
        if (support.supported) {
          return {
            codec,
            resolution: res,
            width,
            height,
            bitrate,
            downgradedTo720p: preferredResolution === '1080p' && res === '720p'
          }
        }
      } catch {
        // 繼續嘗試下一組 codec
      }
    }
  }

  throw new Error('您的裝置或瀏覽器不支援 H.264 MP4 硬體／軟體編碼，請改用最新版 Chrome 或 Safari。')
}

export interface VideoExportProgress {
  phase: 'prewarming' | 'encoding' | 'paused' | 'muxing'
  currentFrame: number
  totalFrames: number
  percent: number
  downgradedTo720p: boolean
}

/**
 * 依據規格書 §5.2.4 執行「圖磚預熱」：
 * 正式輸出前，用「同一個地圖實例、同樣尺寸與鏡頭」把每個地圖段落取樣跑一次，
 * 讓所需圖磚進入瀏覽器與 MapLibre 快取，正式逐幀輸出時幾乎不必再等網路。
 * NOTE: 必須與正式輸出同尺寸——不同尺寸會算出不同的縮放層級，預熱到的是用不到的圖磚
 */
async function prewarmMapTiles(
  journey: Journey,
  timeline: Segment[],
  mapRenderer: DeterministicMapRenderer,
  viewport: { width: number; height: number },
  signal?: AbortSignal,
  onProgress?: (ratio: number) => void
): Promise<void> {
  const activeStations = getActiveStations(journey)
  const mapSegments = timeline.filter(
    (s) => s.type === 'OPENING_LOCATOR' || s.type === 'MOVE' || s.type === 'OUTRO'
  )
  if (mapSegments.length === 0) return

  const samplesPerSegment = 8
  const total = mapSegments.length * samplesPerSegment
  let completed = 0

  for (const seg of mapSegments) {
    for (let i = 0; i < samplesPerSegment; i++) {
      if (signal?.aborted) return
      const t = i / (samplesPerSegment - 1)
      mapRenderer.setCamera(cameraAt(seg, t, activeStations, viewport))
      await mapRenderer.renderNow(true, 4000)
      completed += 1
      onProgress?.(completed / total)
    }
  }
}

/**
 * 輸出期間保持螢幕常亮（Screen Wake Lock API；不支援時靜默略過）
 */
async function requestScreenWakeLock(): Promise<{ release: () => Promise<void> } | null> {
  try {
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> }
    }
    if (!nav.wakeLock) return null
    return await nav.wakeLock.request('screen')
  } catch {
    return null
  }
}

/**
 * 分頁切到背景時，手機瀏覽器會暫停或中斷硬體編碼；此時暫停逐幀迴圈，回到前景再繼續
 */
async function waitUntilPageVisible(signal?: AbortSignal): Promise<void> {
  if (typeof document === 'undefined' || document.visibilityState === 'visible') return
  await new Promise<void>((resolve) => {
    const onChange = () => {
      if (document.visibilityState === 'visible' || signal?.aborted) {
        document.removeEventListener('visibilitychange', onChange)
        resolve()
      }
    }
    document.addEventListener('visibilitychange', onChange)
    signal?.addEventListener('abort', onChange, { once: true })
  })
}

/**
 * 依據規格書 §5.2 使用 WebCodecs + Mediabunny 逐格確定性渲染並輸出 MP4 影片 Blob
 * @param journey 旅程資料
 * @param timeline 段落時間軸
 * @param options 進度回呼與取消訊號
 * @returns MP4 影片 Blob 與是否自動降級 720p 的資訊
 */
export async function exportJourneyVideoMp4(
  journey: Journey,
  timeline: Segment[],
  options?: {
    signal?: AbortSignal
    onProgress?: (progress: VideoExportProgress) => void
  }
): Promise<{
  mp4Blob: Blob
  resolutionUsed: VideoResolution
  downgradedTo720p: boolean
  /** 等待逾時、地圖圖磚未完整載入就輸出的幀數 */
  incompleteMapFrames: number
}> {
  if (!isWebCodecsSupported()) {
    throw new Error('此瀏覽器不支援 WebCodecs，請改用 Chrome 或 Safari。')
  }

  const encoderConfig = await probeSupportedH264Config(
    journey.settings.orientation,
    journey.settings.resolution
  )

  const { width, height, codec, bitrate, resolution, downgradedTo720p } = encoderConfig
  const totalDurationMs = calculateTotalDurationMs(timeline)
  const totalFrames = Math.max(1, Math.ceil((totalDurationMs / 1000) * VIDEO_FPS))
  const frameDurationUs = Math.round(1_000_000 / VIDEO_FPS)

  // 1. 圖磚預熱階段
  options?.onProgress?.({
    phase: 'prewarming',
    currentFrame: 0,
    totalFrames,
    percent: 2,
    downgradedTo720p
  })

  if (options?.signal?.aborted) {
    throw new DOMException('已取消輸出', 'AbortError')
  }

  // 2. 初始化 Mediabunny MP4 輸出與 WebCodecs VideoEncoder
  const bufferTarget = new BufferTarget()
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: bufferTarget
  })

  const packetSource = new EncodedVideoPacketSource('avc')
  output.addVideoTrack(packetSource, {
    frameRate: VIDEO_FPS
  })

  await output.start()

  let packetWriteChain = Promise.resolve()
  let encoderError: Error | null = null

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      const packet = EncodedPacket.fromEncodedChunk(chunk)
      packetWriteChain = packetWriteChain
        .then(() => packetSource.add(packet, meta))
        .catch((err) => {
          encoderError = err instanceof Error ? err : new Error(String(err))
        })
    },
    error: (err) => {
      encoderError = new Error(err.message || 'VideoEncoder 編碼錯誤')
    }
  })

  videoEncoder.configure({
    codec,
    width,
    height,
    bitrate,
    framerate: VIDEO_FPS,
    avc: { format: 'avc' }
  })

  // 3. 建立主畫布、地圖渲染器與圖層合成器
  const mainCanvas = document.createElement('canvas')
  mainCanvas.width = width
  mainCanvas.height = height
  const ctx = mainCanvas.getContext('2d')
  if (!ctx) {
    throw new Error('無法建立輸出主畫布')
  }

  const mapRenderer = new DeterministicMapRenderer()
  const framePainter = new FramePainter()
  const wakeLock = await requestScreenWakeLock()

  try {
    await mapRenderer.initialize(width, height)

    await prewarmMapTiles(journey, timeline, mapRenderer, { width, height }, options?.signal, (ratio) => {
      options?.onProgress?.({
        phase: 'prewarming',
        currentFrame: 0,
        totalFrames,
        percent: Math.round(ratio * 10),
        downgradedTo720p
      })
    })

    for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
      if (options?.signal?.aborted) {
        throw new DOMException('已取消輸出', 'AbortError')
      }
      if (encoderError) {
        throw encoderError
      }

      if (document.visibilityState !== 'visible') {
        options?.onProgress?.({
          phase: 'paused',
          currentFrame: frameIdx,
          totalFrames,
          percent: 10 + Math.round((frameIdx / totalFrames) * 85),
          downgradedTo720p
        })
        await waitUntilPageVisible(options?.signal)
        if (options?.signal?.aborted) {
          throw new DOMException('已取消輸出', 'AbortError')
        }
      }

      const globalTimeMs = (frameIdx / VIDEO_FPS) * 1000
      const timestampUs = Math.round(frameIdx * frameDurationUs)

      // 繪製當前幀並等待地圖 idle
      await framePainter.renderFrameAtTime(
        ctx,
        width,
        height,
        journey,
        timeline,
        globalTimeMs,
        mapRenderer,
        true
      )

      // 控制編碼佇列背壓，避免行動裝置記憶體暴增
      while (videoEncoder.encodeQueueSize > 8) {
        await new Promise((r) => setTimeout(r, 10))
      }

      const videoFrame = new VideoFrame(mainCanvas, {
        timestamp: timestampUs,
        duration: frameDurationUs
      })

      const isKeyFrame = frameIdx % (VIDEO_FPS * 2) === 0
      videoEncoder.encode(videoFrame, { keyFrame: isKeyFrame })
      videoFrame.close()

      const encodePercent = 10 + Math.round(((frameIdx + 1) / totalFrames) * 85)
      options?.onProgress?.({
        phase: 'encoding',
        currentFrame: frameIdx + 1,
        totalFrames,
        percent: Math.min(95, encodePercent),
        downgradedTo720p
      })
    }

    // 4. Flush 編碼器並完成 MP4 封裝
    options?.onProgress?.({
      phase: 'muxing',
      currentFrame: totalFrames,
      totalFrames,
      percent: 97,
      downgradedTo720p
    })

    await videoEncoder.flush()
    videoEncoder.close()
    await packetWriteChain

    if (encoderError) {
      throw encoderError
    }

    packetSource.close()
    await output.finalize()

    const arrayBuffer = bufferTarget.buffer
    if (!arrayBuffer) {
      throw new Error('MP4 封裝完成但未產生有效緩衝區')
    }

    options?.onProgress?.({
      phase: 'muxing',
      currentFrame: totalFrames,
      totalFrames,
      percent: 100,
      downgradedTo720p
    })

    return {
      mp4Blob: new Blob([arrayBuffer], { type: 'video/mp4' }),
      resolutionUsed: resolution,
      downgradedTo720p,
      incompleteMapFrames: mapRenderer.incompleteFrameCount
    }
  } finally {
    if (videoEncoder.state !== 'closed') {
      try {
        videoEncoder.close()
      } catch {
        // 忽略關閉例外
      }
    }
    if (output.state === 'started') {
      try {
        await output.cancel()
      } catch {
        // 忽略取消例外
      }
    }
    framePainter.disposeBitmaps()
    mapRenderer.destroy()
    if (wakeLock) {
      try {
        await wakeLock.release()
      } catch {
        // 忽略釋放例外
      }
    }
    mainCanvas.width = 0
    mainCanvas.height = 0
  }
}
