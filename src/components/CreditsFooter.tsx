import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { BUILTIN_TRACKS } from '../constants/music-library'

interface CreditEntry {
  name: string
  license: string
  url: string
  note?: string
}

/** 網頁中實際使用的開源套件（版權與授權條款屬於各原作者） */
const OPEN_SOURCE_LIBRARIES: CreditEntry[] = [
  { name: 'React', license: 'MIT', url: 'https://react.dev/' },
  { name: 'Zustand', license: 'MIT', url: 'https://github.com/pmndrs/zustand' },
  { name: 'MapLibre GL JS', license: 'BSD-3-Clause', url: 'https://maplibre.org/' },
  { name: 'Mediabunny', license: 'MPL-2.0', url: 'https://github.com/Vanilagy/mediabunny', note: '影片封裝，未經修改' },
  { name: 'exifr', license: 'MIT', url: 'https://github.com/MikeKovarik/exifr', note: '讀取照片 GPS 與拍攝時間' },
  {
    name: 'heic2any',
    license: 'MIT',
    url: 'https://github.com/alexcorvi/heic2any',
    note: '內含 libheif（LGPL-3.0，未經修改）'
  },
  { name: 'idb', license: 'ISC', url: 'https://github.com/jakearchibald/idb' },
  { name: 'Turf.js', license: 'MIT', url: 'https://turfjs.org/', note: '地理距離與路線計算' },
  { name: 'dnd kit', license: 'MIT', url: 'https://dndkit.com/', note: '照片拖曳排序' },
  { name: 'Lucide 圖示', license: 'ISC', url: 'https://lucide.dev/' },
  { name: 'Tailwind CSS', license: 'MIT', url: 'https://tailwindcss.com/' },
  { name: 'Vite', license: 'MIT', url: 'https://vite.dev/', note: '建置工具' },
  { name: 'Vitest', license: 'MIT', url: 'https://vitest.dev/', note: '測試工具' }
]

/** 地圖資料與線上服務 */
const MAP_DATA_AND_SERVICES: CreditEntry[] = [
  {
    name: 'OpenStreetMap 貢獻者',
    license: 'ODbL',
    url: 'https://www.openstreetmap.org/copyright',
    note: '地圖、地名與道路資料'
  },
  { name: 'OpenMapTiles', license: 'CC-BY 4.0', url: 'https://openmaptiles.org/', note: '向量圖磚架構' },
  { name: 'OpenFreeMap', license: '免費公開服務', url: 'https://openfreemap.org/', note: '地圖圖磚與字型' },
  { name: 'Noto Sans', license: 'SIL OFL 1.1', url: 'https://fonts.google.com/noto', note: '地圖上的文字字型' },
  {
    name: 'Nominatim',
    license: 'OSM 基金會公開服務',
    url: 'https://nominatim.org/',
    note: '由座標查詢地名'
  },
  { name: 'OSRM', license: 'BSD-2-Clause', url: 'https://project-osrm.org/', note: '公開示範伺服器，規劃陸路路線' }
]

/** 內建配樂（CC0 公眾領域，不需標示，仍列出以示感謝） */
const MUSIC_CREDITS: CreditEntry[] = BUILTIN_TRACKS.map((t) => ({
  name: `${t.title}`,
  license: 'CC0',
  url: t.sourceUrl,
  note: `${t.style} · ${t.author}（OpenGameArt）`
}))

function CreditList({ title, entries }: { title: string; entries: CreditEntry[] }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-bold tracking-wide text-amber-300">{title}</h3>
      <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-950/60">
        {entries.map((entry) => (
          <li key={entry.name} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-2">
            <span className="min-w-0">
              <a
                href={entry.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block py-1 font-semibold text-slate-100 underline decoration-slate-600 underline-offset-2 hover:decoration-amber-400"
              >
                {entry.name}
              </a>
              {entry.note && <span className="ml-2 text-slate-400">{entry.note}</span>}
            </span>
            <span className="shrink-0 font-mono text-[11px] text-slate-400">{entry.license}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * 頁面底部置中的作者署名，點擊後開啟「關於」對話框：作品說明、非商業聲明與開源致謝
 */
export function CreditsFooter() {
  const [isOpen, setIsOpen] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false)
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKey)
    }
  }, [isOpen])

  return (
    <footer className="border-t border-slate-800/80 px-4 py-5 text-center">
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="rounded-lg px-3 py-2 text-sm text-slate-400 underline-offset-4 transition hover:text-amber-300 hover:underline"
      >
        程式設計：徐承佑
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
          onClick={() => setIsOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="credits-title"
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-slate-700 bg-slate-900 text-left shadow-2xl"
          >
            <div className="flex items-start justify-between gap-3 border-b border-slate-800 px-5 py-4">
              <div>
                <h2 id="credits-title" className="text-base font-bold text-white">
                  關於足跡影片
                </h2>
                <p className="mt-0.5 text-sm text-slate-300">程式設計：徐承佑</p>
              </div>
              <button
                type="button"
                aria-label="關閉"
                onClick={() => setIsOpen(false)}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-800 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-5 overflow-y-auto px-5 py-4 text-sm text-slate-300">
              <div className="space-y-2 leading-relaxed">
                <p>本工具為 vibe coding 練習作品，供個人與親友非商業使用，無任何商業用途，也不以營利為目的。</p>
                <p>
                  照片全程在您的瀏覽器中處理，不會上傳到任何伺服器；查詢地名與規劃路線時，只會把站點的座標送到下列公開服務。
                </p>
              </div>

              <div className="space-y-4 text-xs">
                <h3 className="text-sm font-bold text-white">致謝</h3>
                <CreditList title="開源套件" entries={OPEN_SOURCE_LIBRARIES} />
                <CreditList title="地圖資料與線上服務" entries={MAP_DATA_AND_SERVICES} />
                <CreditList title="內建配樂" entries={MUSIC_CREDITS} />
                <p className="leading-relaxed text-slate-400">
                  以上專案的著作權均屬各原作者與貢獻者所有，並依各自的授權條款使用；完整條款請見各專案網站。影片中的地圖畫面依授權要求標示「©
                  OpenMapTiles」與「© OpenStreetMap contributors」。
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </footer>
  )
}
