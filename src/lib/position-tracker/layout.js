export const COMPACT_MAX_WIDTH = 640;
export const LAYOUT_STORAGE_KEY = 'position_tracker_layout';

export function getTrackerStorage() {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadLayoutPreference(storage = getTrackerStorage()) {
  try {
    return storage?.getItem(LAYOUT_STORAGE_KEY) === 'mobile' ? 'mobile' : 'auto';
  } catch {
    return 'auto';
  }
}

export function saveLayoutPreference(preference, storage = getTrackerStorage()) {
  try {
    storage?.setItem(LAYOUT_STORAGE_KEY, preference === 'mobile' ? 'mobile' : 'auto');
  } catch { /* The current view still works when storage is blocked or full. */ }
}

export function isCompactLayout(viewportWidth, preference) {
  return viewportWidth <= COMPACT_MAX_WIDTH || preference === 'mobile';
}
