import { useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import { BUILTIN_TRACKS, builtinTrackUrl } from '../constants/music-library'
import { musicVolumeAt } from '../services/music'
import type { Journey } from '../types/journey'

/** 預覽與音樂時間差超過此值（秒）才重新對齊，避免一直跳動 */
const RESYNC_THRESHOLD_SEC = 0.3

/**
 * 預覽播放時同步播放配樂：音樂循環、與影片時間對齊，音量套用與輸出相同的淡入淡出
 * @param timeRef 預覽目前時間（毫秒）
 */
export function usePreviewMusic(
  journey: Journey,
  isPlaying: boolean,
  timeRef: MutableRefObject<number>,
  totalDurationMs: number
): void {
  const music = journey.settings.music
  const customBlob = journey.customMusic?.blob

  const customUrl = useMemo(() => (customBlob ? URL.createObjectURL(customBlob) : null), [customBlob])
  useEffect(() => () => {
    if (customUrl) URL.revokeObjectURL(customUrl)
  }, [customUrl])

  let url: string | null = null
  if (music.source === 'builtin') {
    const track = BUILTIN_TRACKS.find((t) => t.id === music.builtinTrackId) ?? BUILTIN_TRACKS[0]
    url = builtinTrackUrl(track)
  } else if (music.source === 'custom') {
    url = customUrl
  }

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const volumeRef = useRef(music.volume)
  volumeRef.current = music.volume

  // 換曲時重建播放器
  useEffect(() => {
    if (!url) {
      audioRef.current = null
      return
    }
    const audio = new Audio(url)
    audio.loop = true
    audio.preload = 'auto'
    audioRef.current = audio
    return () => {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      if (audioRef.current === audio) audioRef.current = null
    }
  }, [url])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    if (!isPlaying) {
      audio.pause()
      return
    }

    const totalSec = totalDurationMs / 1000
    const sync = () => {
      const timeSec = timeRef.current / 1000
      const duration = audio.duration
      if (Number.isFinite(duration) && duration > 0) {
        const expected = timeSec % duration
        if (Math.abs(audio.currentTime - expected) > RESYNC_THRESHOLD_SEC) audio.currentTime = expected
      }
      audio.volume = musicVolumeAt(timeSec, totalSec, volumeRef.current)
    }
    sync()
    void audio.play().catch(() => undefined)
    const timer = setInterval(sync, 200)
    return () => {
      clearInterval(timer)
      audio.pause()
    }
  }, [isPlaying, url, totalDurationMs, timeRef])
}
