export function parseEpisodeRuntimeMinutes(value) {
  if (value == null || value === "") {
    return 0;
  }

  const numericValue = Number(value);
  if (Number.isFinite(numericValue) && numericValue > 0) {
    return numericValue;
  }

  const normalized = String(value).trim().toLowerCase();
  const hourMatch = normalized.match(/(\d+(?:\.\d+)?)\s*h/);
  const minuteMatch = normalized.match(/(\d+)\s*m(?:in)?/);
  if (hourMatch || minuteMatch) {
    const hours = hourMatch ? Number(hourMatch[1]) : 0;
    const minutes = minuteMatch ? Number(minuteMatch[1]) : 0;
    return Math.round(hours * 60 + minutes);
  }

  const digits = normalized.replace(/\D/g, "");
  const parsed = Number(digits);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function normalizeEpisodeImdbRating(value) {
  const rating = Number(value);
  return Number.isFinite(rating) && rating > 0 ? rating : null;
}
