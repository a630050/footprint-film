import type { BuiltinTrackId } from '../types/journey'

export interface BuiltinTrack {
  id: BuiltinTrackId
  /** 風格（介面主要顯示） */
  style: string
  title: string
  author: string
  durationSec: number
  /** 相對於網站根目錄的檔案路徑（由原始檔轉成 AAC，iPhone 也能播放） */
  file: string
  /** 原始發布頁面（授權依據） */
  sourceUrl: string
}

/**
 * 內建曲庫：5 首皆為 CC0 或公眾領域（4 首來自 OpenGameArt，鋼琴曲來自 Wikimedia Commons），
 * 可自由使用、不需標示作者，仍在「關於」對話框列出曲名與作者以示感謝。
 * 所有曲目都已統一響度為 -14 LUFS（與 YouTube、Spotify 播放音量相近），切換曲目時音量一致。
 */
export const BUILTIN_TRACKS: BuiltinTrack[] = [
  {
    id: 'acoustic',
    style: '輕快木吉他',
    title: 'Apple Cider',
    author: 'Zane Little Music',
    durationSec: 200,
    file: 'music/acoustic-apple-cider.m4a',
    sourceUrl: 'https://opengameart.org/content/apple-cider'
  },
  {
    id: 'piano',
    style: '歡樂鋼琴',
    title: 'The Entertainer',
    author: 'Scott Joplin 作曲・James Brigham 演奏',
    durationSec: 306,
    file: 'music/piano-the-entertainer.m4a',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:%22The_Entertainer%22_(1902),_by_Scott_Joplin.mp3'
  },
  {
    id: 'lofi',
    style: '放鬆 Lo-fi',
    title: 'Chill lofi inspired',
    author: 'omfgdude',
    durationSec: 123,
    file: 'music/lofi-chill.m4a',
    sourceUrl: 'https://opengameart.org/content/chill-lofi-inspired'
  },
  {
    id: 'cinematic',
    style: '史詩電影感',
    title: 'Fantasy Orchestral Theme',
    author: 'Joth',
    durationSec: 192,
    file: 'music/cinematic-fantasy-orchestral.m4a',
    sourceUrl: 'https://opengameart.org/content/fantasy-orchestral-theme'
  },
  {
    id: 'summer',
    style: '夏日歡樂',
    title: 'Feel Good Summer Tune',
    author: 'skrjablin',
    durationSec: 182,
    file: 'music/summer-feel-good.m4a',
    sourceUrl: 'https://opengameart.org/content/feel-good-summer-tune'
  }
]

/** 取得內建曲目的完整網址（網站部署在子路徑時也正確） */
export function builtinTrackUrl(track: BuiltinTrack): string {
  return `${import.meta.env.BASE_URL}${track.file}`
}

/** 配樂開頭淡入、結尾淡出的秒數 */
export const MUSIC_FADE_IN_SEC = 1
export const MUSIC_FADE_OUT_SEC = 2.5

/** 使用者上傳音樂檔的大小上限 */
export const MAX_CUSTOM_MUSIC_BYTES = 30 * 1024 * 1024
