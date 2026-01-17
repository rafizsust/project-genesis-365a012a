/**
 * Speech Recognition Module Exports
 */

export * from './types';
export * from './browserDetection';
export * from './pauseMetrics';
export * from './ghostWordTracker';
export {
  getStoredAccent,
  setStoredAccent,
  clearStoredAccent,
  hasAutoDetectedAccent,
  markAccentAutoDetected,
  detectAccentFromTimezone,
  detectAccentFromGeolocation,
  getStoredAccentAsync,
} from './accentStorage';
