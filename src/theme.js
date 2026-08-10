export const THEME_KEY = "radarThemeMode";
export const THEME_MODES = Object.freeze(["auto", "light", "dark"]);
export const AUTO_LIGHT_START_HOUR = 7;
export const AUTO_DARK_START_HOUR = 19;

export function normalizeThemeMode(value) {
  return THEME_MODES.includes(value) ? value : "auto";
}

export function resolveTheme(mode, date = new Date()) {
  const normalized = normalizeThemeMode(mode);
  if (normalized !== "auto") return normalized;

  const hour = date instanceof Date ? date.getHours() : new Date(date).getHours();
  if (!Number.isFinite(hour)) return "light";
  return hour >= AUTO_LIGHT_START_HOUR && hour < AUTO_DARK_START_HOUR
    ? "light"
    : "dark";
}

export function nextThemeMode(mode) {
  const currentIndex = THEME_MODES.indexOf(normalizeThemeMode(mode));
  return THEME_MODES[(currentIndex + 1) % THEME_MODES.length];
}
