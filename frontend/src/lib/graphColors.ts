export function nodeSize(followerCount?: number | null): number {
  if (!followerCount) return 20
  if (followerCount >= 1_000_000) return 64
  if (followerCount >= 100_000) return 48
  if (followerCount >= 10_000) return 36
  if (followerCount >= 1_000) return 28
  return 20
}
