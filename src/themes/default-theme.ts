/**
 * 預設視覺主題設定檔
 * NOTE: 依據 §5.4，所有外觀參數集中在單一主題設定檔：
 * 底圖樣式、站點標記（預設黃色圓點＋白框＋呼吸效果）、地名氣泡（預設白底黑字圓角卡片）、
 * 路線顏色與粗細（預設藍色粗線）、字幕字體與顏色、漸層強度
 */

export interface VisualTheme {
  name: string
  fontFamily: string
  stationMarker: {
    fillColor: string
    ActiveFillColor: string
    strokeColor: string
    strokeWidth: number
    radiusPx: number
    pulseColor: string
  }
  placeBubble: {
    backgroundColor: string
    textColor: string
    borderRadiusPx: number
    paddingX: number
    paddingY: number
    shadowColor: string
  }
  routeLine: {
    color: string
    glowColor: string
    widthPx: number
    dashArrayFlight: number[]
  }
  overlayGradient: {
    topStopAlpha: number
    bottomStopAlpha: number
    heightRatio: number
  }
  typography: {
    primaryTextColor: string
    secondaryTextColor: string
    accentTextColor: string
  }
}

export const DEFAULT_VISUAL_THEME: VisualTheme = {
  name: '預設回憶主題',
  fontFamily:
    '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", -apple-system, BlinkMacSystemFont, sans-serif',
  stationMarker: {
    fillColor: '#FACC15', // 黃色圓點
    ActiveFillColor: '#F59E0B',
    strokeColor: '#FFFFFF', // 白框
    strokeWidth: 4,
    radiusPx: 11,
    pulseColor: 'rgba(250, 204, 21, 0.38)' // 呼吸效果
  },
  placeBubble: {
    backgroundColor: 'rgba(255, 255, 255, 0.96)', // 白底
    textColor: '#0F172A', // 黑字
    borderRadiusPx: 12,
    paddingX: 16,
    paddingY: 10,
    shadowColor: 'rgba(15, 23, 42, 0.28)'
  },
  routeLine: {
    color: '#3B82F6', // 藍色粗線
    glowColor: 'rgba(59, 130, 246, 0.35)',
    widthPx: 6,
    dashArrayFlight: [2, 1.5]
  },
  overlayGradient: {
    topStopAlpha: 0.45,
    bottomStopAlpha: 0.78,
    heightRatio: 0.36
  },
  typography: {
    primaryTextColor: '#FFFFFF',
    secondaryTextColor: 'rgba(241, 245, 249, 0.9)',
    accentTextColor: '#FDE047'
  }
}
