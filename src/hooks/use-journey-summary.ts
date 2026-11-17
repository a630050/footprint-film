import { useMemo } from 'react'
import {
  buildJourneyTimeline,
  calculateTotalDurationMs,
  formatDurationHuman
} from '../domain/timeline-builder'
import { useJourneyStore } from '../store/journey-store'

/**
 * 根據當前旅程與設定即時計算段落時間軸與預估影片總長度
 */
export function useJourneySummary() {
  const journey = useJourneyStore((s) => s.journey)
  const groundRoutes = useJourneyStore((s) => s.groundRoutes)

  return useMemo(() => {
    const allPhotos = Object.values(journey.photos)
    const totalCount = allPhotos.length
    const exifCount = allPhotos.filter(
      (p) => p.locationSource === 'exif' || p.locationSource === 'manual'
    ).length
    const inferredCount = allPhotos.filter((p) => p.locationSource === 'inferred').length
    const unassignedCount = journey.unassignedPhotoIds.length
    const includedCount = allPhotos.filter((p) => p.included).length

    const timeline = buildJourneyTimeline(journey, groundRoutes)
    const totalDurationMs = calculateTotalDurationMs(timeline)
    const formattedDuration = formatDurationHuman(totalDurationMs)

    const missingLocationRatio =
      totalCount > 0 ? (totalCount - exifCount) / totalCount : 0

    return {
      totalCount,
      exifCount,
      inferredCount,
      unassignedCount,
      includedCount,
      timeline,
      totalDurationMs,
      formattedDuration,
      isMoreThanHalfMissingLocation: totalCount > 0 && missingLocationRatio > 0.5
    }
  }, [journey, groundRoutes])
}
