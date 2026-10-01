/** Now in UTC to the second, as `2026-10-01T13:03:09+00:00` (the Python version's format). */
export const isoNow = (): string => new Date().toISOString().replace(/\.\d+Z$/, "+00:00")
