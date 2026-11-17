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
 * 內建曲庫：5 首皆為 OpenGameArt 上以 CC0（公眾領域）授權發布的曲目，可自由使用、不需標示作者。
 * 仍在「關於」對話框列出曲名與作者以示感謝。
 */
export const BUILTIN_TRACKS: BuiltinTrack[] = [
  {
    id: 'acoustic',
    style: '輕快木吉他',
    title: 'Exploration',
    author: 'johnclark',
    durationSec: 21,
    file: 'music/acoustic-exploration.m4a',
    sourceUrl: 'https://opengameart.org/content/exploration-0'
  },
  {
    id: 'piano',
    style: '溫馨鋼琴',
    title: 'Bright Eyes',
    author: 'tomcat',
    durationSec: 66,
    file: 'music/piano-bright-eyes.m4a',
    sourceUrl: 'https://opengameart.org/content/bright-eyes'
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
