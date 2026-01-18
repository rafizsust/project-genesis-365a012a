// Tracks client-side speaking submission progress across route changes.
// Stored in sessionStorage so History can render progress without blocking the user.

export type SpeakingSubmissionStage =
  | 'preparing'
  | 'converting'
  | 'uploading'
  | 'queuing'
  | 'evaluating'
  | 'finalizing'
  | 'completed'
  | 'failed';

export interface SpeakingSubmissionTiming {
  conversionMs?: number;
  uploadMs?: number;
  evaluationMs?: number;
  totalMs?: number;
}

export interface SpeakingSubmissionTracker {
  testId: string;
  mode: 'basic' | 'accuracy';
  stage: SpeakingSubmissionStage;
  detail?: string;
  startedAt: number; // epoch ms
  updatedAt: number; // epoch ms
  timing?: SpeakingSubmissionTiming;
  lastError?: string;
}

const storageKey = (testId: string) => `speaking_submission_tracker:${testId}`;

export function getSpeakingSubmissionTracker(testId: string): SpeakingSubmissionTracker | null {
  try {
    const raw = sessionStorage.getItem(storageKey(testId));
    if (!raw) return null;
    return JSON.parse(raw) as SpeakingSubmissionTracker;
  } catch {
    return null;
  }
}

export function setSpeakingSubmissionTracker(testId: string, tracker: SpeakingSubmissionTracker) {
  try {
    sessionStorage.setItem(storageKey(testId), JSON.stringify(tracker));
    window.dispatchEvent(new CustomEvent('speaking-submission-tracker', { detail: { testId, tracker } }));
  } catch {
    // ignore
  }
}

export function patchSpeakingSubmissionTracker(
  testId: string,
  patch: Partial<Omit<SpeakingSubmissionTracker, 'testId'>>
) {
  const existing = getSpeakingSubmissionTracker(testId);
  const now = Date.now();
  const next: SpeakingSubmissionTracker = {
    testId,
    mode: existing?.mode ?? 'basic',
    stage: existing?.stage ?? 'preparing',
    startedAt: existing?.startedAt ?? now,
    updatedAt: now,
    ...existing,
    ...patch,
    timing: {
      ...(existing?.timing || {}),
      ...(patch.timing || {}),
    },
  };
  setSpeakingSubmissionTracker(testId, next);
}

export function clearSpeakingSubmissionTracker(testId: string) {
  try {
    // Before clearing, persist timing to a separate key so History can still display it
    const tracker = getSpeakingSubmissionTracker(testId);
    if (tracker?.timing && (tracker.timing.totalMs || tracker.timing.evaluationMs)) {
      const timingKey = `speaking_submission_timing:${testId}`;
      sessionStorage.setItem(timingKey, JSON.stringify({
        timing: tracker.timing,
        completedAt: Date.now(),
      }));
    }
    
    sessionStorage.removeItem(storageKey(testId));
    window.dispatchEvent(new CustomEvent('speaking-submission-tracker', { detail: { testId, tracker: null } }));
  } catch {
    // ignore
  }
}

/**
 * Get persisted timing data after tracker was cleared
 * History page can use this to show timing even after navigation
 */
export function getPersistedTiming(testId: string): SpeakingSubmissionTiming | null {
  try {
    const timingKey = `speaking_submission_timing:${testId}`;
    const raw = sessionStorage.getItem(timingKey);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data.timing || null;
  } catch {
    return null;
  }
}

/**
 * Clear persisted timing (call after displaying or after some time)
 */
export function clearPersistedTiming(testId: string) {
  try {
    sessionStorage.removeItem(`speaking_submission_timing:${testId}`);
  } catch {
    // ignore
  }
}
