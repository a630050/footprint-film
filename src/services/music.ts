import {
  BUILTIN_TRACKS,
  builtinTrackUrl,
  MUSIC_FADE_IN_SEC,
  MUSIC_FADE_OUT_SEC
} from '../constants/music-library'
import type { Journey } from '../types/journey'

/** 輸出音軌的取樣率（AAC 與 Opus 都支援） */
export const MUSIC_SAMPLE_RATE = 48000

/**
 * 目前旅程選用的配樂來源：內建曲目的網址或使用者上傳的檔案；未選配樂時回傳 null
 */
export function getMusicSource(journey: Journey): { key: string; load: () => Promise<ArrayBuffer> } | null {
  const music = journey.settings.music
  if (music.source === 'builtin') {
    const track = BUILTIN_TRACKS.find((t) => t.id === music.builtinTrackId) ?? BUILTIN_TRACKS[0]
    const url = builtinTrackUrl(track)
    return {
      key: `builtin:${track.id}`,
      load: async () => {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`配樂下載失敗（HTTP ${res.status}）`)
        return res.arrayBuffer()
      }
    }
  }
  if (music.source === 'custom' && journey.customMusic) {
    const blob = journey.customMusic.blob
    return { key: `custom:${journey.customMusic.fileName}:${blob.size}`, load: () => blob.arrayBuffer() }
  }
  return null
}

/** 解碼音樂檔；無法解碼時拋出錯誤 */
export async function decodeMusic(data: ArrayBuffer): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, 1, MUSIC_SAMPLE_RATE)
  try {
    return await ctx.decodeAudioData(data)
  } catch {
    throw new Error('無法讀取這個音樂檔，請改用 MP3、M4A 或 WAV 格式。')
  }
}

/**
 * 依影片長度產生配樂音軌：音樂太短就循環、太長就裁掉，開頭淡入、結尾淡出，並套用音量
 * @param source 解碼後的音樂
 * @param durationSec 影片長度（秒）
 * @param volume 0 ~ 1
 */
export async function renderMusicForVideo(source: AudioBuffer, durationSec: number, volume: number): Promise<AudioBuffer> {
  const length = Math.max(1, Math.ceil(durationSec * MUSIC_SAMPLE_RATE))
  const ctx = new OfflineAudioContext(2, length, MUSIC_SAMPLE_RATE)
  const node = ctx.createBufferSource()
  node.buffer = source
  node.loop = true

  const gain = ctx.createGain()
  const v = Math.max(0, Math.min(1, volume))
  const fadeIn = Math.min(MUSIC_FADE_IN_SEC, durationSec / 4)
  const fadeOut = Math.min(MUSIC_FADE_OUT_SEC, durationSec / 3)
  gain.gain.setValueAtTime(0, 0)
  gain.gain.linearRampToValueAtTime(v, fadeIn)
  gain.gain.setValueAtTime(v, Math.max(fadeIn, durationSec - fadeOut))
  gain.gain.linearRampToValueAtTime(0, durationSec)

  node.connect(gain).connect(ctx.destination)
  node.start(0)
  return ctx.startRendering()
}

/**
 * 預覽時的配樂音量：與輸出相同的淡入淡出曲線
 * @param timeSec 影片目前時間
 * @param durationSec 影片總長
 */
export function musicVolumeAt(timeSec: number, durationSec: number, volume: number): number {
  const fadeIn = Math.min(MUSIC_FADE_IN_SEC, durationSec / 4)
  const fadeOut = Math.min(MUSIC_FADE_OUT_SEC, durationSec / 3)
  let factor = 1
  if (timeSec < fadeIn) factor = timeSec / fadeIn
  else if (timeSec > durationSec - fadeOut) factor = Math.max(0, (durationSec - timeSec) / fadeOut)
  return Math.max(0, Math.min(1, volume * factor))
}
