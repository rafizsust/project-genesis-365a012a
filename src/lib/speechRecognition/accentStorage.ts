/**
 * Accent Preference Storage
 * Persists user's accent choice for Chrome
 */

const STORAGE_KEY = 'ielts_preferred_accent';
const DEFAULT_ACCENT = 'en-GB';

export function getStoredAccent(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored || DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

export function setStoredAccent(accent: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, accent);
  } catch {
    console.warn('Failed to store accent preference');
  }
}

export function clearStoredAccent(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore
  }
}
