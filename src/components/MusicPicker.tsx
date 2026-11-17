import { Loader2, Music, Pause, Play, Trash2, Upload, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { BUILTIN_TRACKS, builtinTrackUrl, MAX_CUSTOM_MUSIC_BYTES } from '../constants/music-library'
import { decodeMusic } from '../services/music'
import { useJourneyStore } from '../store/journey-store'
import type { BuiltinTrackId } from '../types/journey'

function formatSec(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * 配樂選擇：無配樂、內建 5 首 CC0 曲目（可試聽）、上傳自己的音樂檔，以及音量
 * 配樂會依影片長度自動循環或裁切，開頭淡入、結尾淡出
 */
export function MusicPicker() {
  const music = useJourneyStore((s) => s.journey.settings.music)
  const customMusic = useJourneyStore((s) => s.journey.customMusic)
  const updateSettings = useJourneyStore((s) => s.updateSettings)
  const setCustomMusic = useJourneyStore((s) => s.setCustomMusic)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const auditionRef = useRef<HTMLAudioElement | null>(null)
  const [auditionId, setAuditionId] = useState<BuiltinTrackId | null>(null)
  const [uploadState, setUploadState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null })

  useEffect(
    () => () => {
      auditionRef.current?.pause()
      auditionRef.current = null
    },
    []
  )

  const setMusic = (patch: Partial<typeof music>) => updateSettings({ music: { ...music, ...patch } })

  const toggleAudition = (id: BuiltinTrackId) => {
    const track = BUILTIN_TRACKS.find((t) => t.id === id)
    if (!track) return
    if (auditionId === id) {
      auditionRef.current?.pause()
      setAuditionId(null)
      return
    }
    auditionRef.current?.pause()
    const audio = new Audio(builtinTrackUrl(track))
    audio.volume = music.volume
    audio.onended = () => setAuditionId(null)
    auditionRef.current = audio
    setAuditionId(id)
    void audio.play().catch(() => setAuditionId(null))
  }

  const handleUpload = async (file: File) => {
    if (file.size > MAX_CUSTOM_MUSIC_BYTES) {
      setUploadState({ busy: false, error: `音樂檔超過 ${MAX_CUSTOM_MUSIC_BYTES / 1024 / 1024} MB，請換一個較小的檔案。` })
      return
    }
    setUploadState({ busy: true, error: null })
    try {
      // 先確認瀏覽器能解碼，避免輸出時才失敗
      await decodeMusic(await file.arrayBuffer())
      setCustomMusic({ blob: file, fileName: file.name })
      setUploadState({ busy: false, error: null })
    } catch (err) {
      setUploadState({ busy: false, error: err instanceof Error ? err.message : '無法讀取這個音樂檔。' })
    }
  }

  const optionClass = (selected: boolean) =>
    `relative flex flex-col gap-1 rounded-xl border p-3 text-left text-xs transition ${
      selected ? 'border-amber-500 bg-amber-500/10 text-amber-100' : 'border-slate-700 bg-slate-800/50 text-slate-300 hover:border-slate-500'
    }`

  return (
    <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/90 p-4 shadow-xl">
      <div>
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-200">
          <Music className="h-4 w-4 text-amber-400" />
          配樂
        </h3>
        <p className="mt-0.5 text-xs text-slate-400">會依影片長度自動循環或裁切，開頭淡入、結尾淡出。內建曲目皆為 CC0 或公眾領域，音量已統一。</p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <button type="button" onClick={() => setMusic({ source: 'none' })} className={optionClass(music.source === 'none')}>
          <VolumeX className="h-4 w-4" />
          <span className="font-semibold">無配樂</span>
        </button>

        {BUILTIN_TRACKS.map((track) => {
          const selected = music.source === 'builtin' && music.builtinTrackId === track.id
          return (
            <div key={track.id} className={optionClass(selected)}>
              <button
                type="button"
                onClick={() => setMusic({ source: 'builtin', builtinTrackId: track.id })}
                className="absolute inset-0 rounded-xl"
                aria-label={`選用 ${track.style}`}
              />
              <span className="pointer-events-none font-semibold">{track.style}</span>
              <span className="pointer-events-none truncate text-[11px] text-slate-400">
                {track.title} · {formatSec(track.durationSec)}
              </span>
              <button
                type="button"
                onClick={() => toggleAudition(track.id)}
                aria-label={auditionId === track.id ? '停止試聽' : '試聽'}
                className="relative mt-1 inline-flex min-h-8 w-fit items-center gap-1 rounded-lg bg-slate-900/80 px-2.5 py-1.5 text-[11px] font-medium text-slate-200 hover:bg-slate-700"
              >
                {auditionId === track.id ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                {auditionId === track.id ? '停止' : '試聽'}
              </button>
            </div>
          )
        })}

        <div className={optionClass(music.source === 'custom')}>
          {customMusic ? (
            <>
              <button
                type="button"
                onClick={() => setMusic({ source: 'custom' })}
                className="absolute inset-0 rounded-xl"
                aria-label="選用自己的音樂"
              />
              <span className="pointer-events-none font-semibold">自己的音樂</span>
              <span className="pointer-events-none truncate text-[11px] text-slate-400">{customMusic.fileName}</span>
              <span className="relative mt-1 flex gap-1">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1 rounded-lg bg-slate-900/80 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700"
                >
                  <Upload className="h-3 w-3" />
                  更換
                </button>
                <button
                  type="button"
                  aria-label="移除自己的音樂"
                  onClick={() => setCustomMusic(undefined)}
                  className="inline-flex items-center rounded-lg bg-slate-900/80 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </span>
            </>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadState.busy}
              className="flex flex-col gap-1 text-left"
            >
              {uploadState.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              <span className="font-semibold">上傳音樂</span>
              <span className="text-[11px] text-slate-400">MP3、M4A、WAV</span>
            </button>
          )}
        </div>
      </div>

      {uploadState.error && <p className="text-xs text-rose-300">{uploadState.error}</p>}

      {music.source !== 'none' && (
        <div className="flex items-center gap-3 text-xs text-slate-300">
          <Volume2 className="h-4 w-4 shrink-0 text-slate-400" />
          <input
            type="range"
            aria-label="配樂音量"
            min={0}
            max={1}
            step={0.05}
            value={music.volume}
            onChange={(e) => setMusic({ volume: Number(e.target.value) })}
            className="flex-1 accent-amber-500"
          />
          <span className="w-10 text-right font-mono">{Math.round(music.volume * 100)}%</span>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,.mp3,.m4a,.aac,.wav"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) void handleUpload(file)
        }}
      />
    </div>
  )
}
