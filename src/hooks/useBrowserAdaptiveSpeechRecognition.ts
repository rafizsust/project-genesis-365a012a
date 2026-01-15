/**
 * Browser-Adaptive Speech Recognition Hook
 * 
 * ARCHITECTURE PRINCIPLES (per Senior Speech Recognition Engineer spec):
 * 
 * 1. ONE CENTRAL RECOGNITION INSTANCE per session
 *    - Only create one SpeechRecognition object per recording session
 *    - Attach handlers once and never recreate mid-session
 * 
 * 2. SEPARATE TRANSCRIPT BUFFER
 *    - Maintain own final/transcript storage
 *    - Don't rely on recognition's internal storage surviving restart
 * 
 * 3. PROACTIVE RESTART via watchdog timer (not reactive)
 *    - Chrome: ~35s max session before proactive restart
 *    - Edge: ~45s max session before proactive restart
 *    - Never call start() inside onresult
 * 
 * 4. BROWSER-ADAPTIVE CONFIG
 *    - Chrome: User-selected accent, controlled cycling
 *    - Edge: Auto-detect language, more tolerance
 * 
 * 5. ERROR HANDLING
 *    - Differentiate genuine errors vs transient vs browser cutoffs
 *    - Small retry counter to avoid loops
 * 
 * 6. USER EXPERIENCE GUARANTEES
 *    - No repeated mic permission requests
 *    - Transcript accumulates seamlessly
 *    - UI never flashes "listening stopped"
 *    - Errors logged but not shown unless critical
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  detectBrowser,
  isSpeechRecognitionSupported,
  BrowserInfo,
  PauseTracker,
  PauseMetrics,
  GhostWordTracker,
  TranscriptState,
  SpeechRecognitionConfig,
  DEFAULT_CONFIG,
  getStoredAccent,
  setStoredAccent,
} from '@/lib/speechRecognition';

// Web Speech API types
type SpeechRecognitionType = typeof window.SpeechRecognition extends new (...args: unknown[]) => infer R ? R : never;

interface UseSpeechRecognitionReturn {
  isListening: boolean;
  isSupported: boolean;
  error: Error | null;
  rawTranscript: string;
  finalTranscript: string;
  interimTranscript: string;
  words: TranscriptState['words'];
  ghostWords: string[];
  pauseMetrics: PauseMetrics | null;
  sessionDuration: number;
  browser: BrowserInfo;
  startListening: () => void;
  stopListening: () => void;
  abort: () => void;
  clearTranscript: () => void;
  selectedAccent: string;
  setAccent: (accent: string) => void;
}

// CRITICAL: Chrome max session before PROACTIVE restart (before Chrome's ~45s cutoff)
const CHROME_MAX_SESSION_MS = 35000;

// Edge max session - Edge has longer tolerance
const EDGE_MAX_SESSION_MS = 45000;

// Delay before restarting after stop (allows clean shutdown)
const RESTART_DELAY_MS = 200;

// Watchdog check interval
const WATCHDOG_INTERVAL_MS = 2000;

// Max time without results before forcing restart
const MAX_SILENCE_BEFORE_RESTART_MS = 12000;

// Maximum consecutive restart failures before giving up
const MAX_CONSECUTIVE_FAILURES = 10;

// Maximum retry attempts for transient errors
const MAX_TRANSIENT_RETRIES = 3;

export function useBrowserAdaptiveSpeechRecognition(
  config: SpeechRecognitionConfig = {}
): UseSpeechRecognitionReturn {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  
  const [browser] = useState<BrowserInfo>(() => detectBrowser());
  const [isSupported] = useState(() => isSpeechRecognitionSupported());
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [rawTranscript, setRawTranscript] = useState('');
  const [finalTranscript, setFinalTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [words, setWords] = useState<TranscriptState['words']>([]);
  const [ghostWords, setGhostWords] = useState<string[]>([]);
  const [pauseMetrics, setPauseMetrics] = useState<PauseMetrics | null>(null);
  const [sessionDuration, setSessionDuration] = useState(0);
  const [selectedAccent, setSelectedAccent] = useState(() => config.accent || getStoredAccent());
  
  // ==================== REFS ====================
  // SINGLE RECOGNITION INSTANCE - one per session, attached once
  const recognitionRef = useRef<SpeechRecognitionType | null>(null);
  
  // Lifecycle flags
  const isRecordingRef = useRef(false);        // True while user wants to record
  const isRestartingRef = useRef(false);       // True during proactive restart cycle
  const isManualStopRef = useRef(false);       // True when user explicitly stops
  
  // Timing
  const sessionStartRef = useRef(0);           // When current recognition session started
  const lastResultAtRef = useRef(0);           // Last time we got a result
  const overallStartRef = useRef(0);           // When recording started (for session duration display)
  
  // Watchdog timer
  const watchdogTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  
  // Silence timeout (for extended periods of no speech)
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // Failure tracking
  const consecutiveFailuresRef = useRef(0);
  const transientRetryCountRef = useRef(0);
  
  // Transcript deduplication
  const wordIdCounterRef = useRef(0);
  const lastProcessedTextRef = useRef(new Set<string>());
  const lastFinalTextRef = useRef('');
  
  // Helpers
  const pauseTrackerRef = useRef(new PauseTracker());
  const ghostTrackerRef = useRef(new GhostWordTracker());
  
  // ==================== SESSION DURATION DISPLAY ====================
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    if (isListening && overallStartRef.current > 0) {
      interval = setInterval(() => {
        setSessionDuration(Date.now() - overallStartRef.current);
      }, 1000);
    }
    return () => { if (interval) clearInterval(interval); };
  }, [isListening]);

  // ==================== CLEANUP ON UNMOUNT ====================
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch { /* ignore */ }
      }
      if (watchdogTimerRef.current) clearInterval(watchdogTimerRef.current);
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    };
  }, []);

  // ==================== HELPER: Should restart on this error? ====================
  const shouldRestartOnError = useCallback((errorType: string): boolean => {
    // Errors that should trigger restart
    const restartableErrors = ['network', 'audio-capture', 'service-not-allowed'];
    // Errors that are transient or expected
    const ignoredErrors = ['no-speech', 'aborted'];
    
    if (ignoredErrors.includes(errorType)) return false;
    if (restartableErrors.includes(errorType)) return true;
    
    // For Edge: network errors often fire incorrectly, treat as restartable
    if (browser.isEdge && errorType === 'network') return true;
    
    return false;
  }, [browser.isEdge]);

  // ==================== HELPER: Reset silence timeout ====================
  const resetSilenceTimeout = useCallback(() => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = setTimeout(() => {
      if (isRecordingRef.current && !isManualStopRef.current) {
        console.warn('[SpeechRecognition] Extended silence detected');
        // Don't set error - just log for fluency scoring
      }
    }, mergedConfig.silenceTimeoutMs);
  }, [mergedConfig.silenceTimeoutMs]);

  // ==================== CORE: Create recognition instance ====================
  const createRecognitionInstance = useCallback((): SpeechRecognitionType | null => {
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) return null;
    
    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = true;
    recognition.interimResults = true;
    
    if (browser.isEdge) {
      // Edge: DO NOT set lang - auto-detect, preserves fillers
      console.log('[SpeechRecognition] Creating Edge instance: Natural/auto-detect mode');
    } else if (browser.isChrome) {
      recognition.lang = selectedAccent;
      console.log(`[SpeechRecognition] Creating Chrome instance: ${selectedAccent}`);
    } else {
      recognition.lang = selectedAccent;
      console.log(`[SpeechRecognition] Creating instance for ${browser.browserName}: ${selectedAccent}`);
    }
    
    return recognition;
  }, [browser, selectedAccent]);

  // ==================== CORE: Safe restart (watchdog-triggered only) ====================
  // This only STOPS the recognition - onend handler will restart it
  const safeRestartRef = useRef<() => void>(() => {});
  
  const safeRestart = useCallback(() => {
    if (!isRecordingRef.current || isManualStopRef.current) {
      console.log('[SpeechRecognition] safeRestart: not recording or manual stop, skipping');
      return;
    }
    
    if (isRestartingRef.current) {
      console.log('[SpeechRecognition] safeRestart: already restarting, skipping');
      return;
    }
    
    isRestartingRef.current = true;
    console.log('[SpeechRecognition] Performing safe restart (stop only, onend will restart)...');
    
    // Stop current instance gracefully - onend will handle restart
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Already stopped - manually trigger restart logic
        console.log('[SpeechRecognition] Already stopped, triggering manual restart');
        const delay = browser.isEdge ? 300 : RESTART_DELAY_MS;
        
        setTimeout(() => {
          if (!isRecordingRef.current || isManualStopRef.current) {
            isRestartingRef.current = false;
            return;
          }
          
          isRestartingRef.current = false;
          sessionStartRef.current = Date.now();
          
          if (recognitionRef.current) {
            try {
              recognitionRef.current.start();
              console.log('[SpeechRecognition] Restarted successfully');
              transientRetryCountRef.current = 0;
            } catch (err) {
              console.error('[SpeechRecognition] Restart failed:', err);
              consecutiveFailuresRef.current++;
            }
          }
        }, delay);
      }
    }
  }, [browser.isEdge]);
  
  // Keep ref in sync
  useEffect(() => {
    safeRestartRef.current = safeRestart;
  }, [safeRestart]);

  // ==================== HANDLER: onresult ====================
  const handleResult = useCallback((event: Event) => {
    if (!isRecordingRef.current) return;
    
    // Update timing for watchdog
    lastResultAtRef.current = Date.now();
    resetSilenceTimeout();
    pauseTrackerRef.current.recordSpeechEvent();
    
    // Reset failure counters on successful result
    consecutiveFailuresRef.current = 0;
    transientRetryCountRef.current = 0;
    
    const e = event as unknown as { resultIndex: number; results: SpeechRecognitionResultList };
    
    let newFinalText = '';
    let newInterimText = '';
    const newWords: TranscriptState['words'] = [];

    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      const transcript = result[0].transcript;

      if (result.isFinal) {
        // CRITICAL: Deduplicate to prevent repeated text after restarts
        const normalizedText = transcript.trim().toLowerCase();
        if (lastProcessedTextRef.current.has(normalizedText) || transcript === lastFinalTextRef.current) {
          console.log('[SpeechRecognition] Skipping duplicate final text');
          continue;
        }

        lastProcessedTextRef.current.add(normalizedText);
        lastFinalTextRef.current = transcript;

        // Keep set size manageable
        if (lastProcessedTextRef.current.size > 50) {
          const entries = Array.from(lastProcessedTextRef.current);
          lastProcessedTextRef.current = new Set(entries.slice(-30));
        }

        const finalWords = transcript.trim().split(/\s+/).filter((w: string) => w.length > 0);
        const finalWordsSet = new Set<string>(finalWords.map((w: string) => w.toLowerCase()));

        // Ghost word recovery for Chrome
        if (browser.isChrome) {
          const recovered = ghostTrackerRef.current.extractAcceptedGhosts(finalWordsSet);
          if (recovered.length > 0) {
            console.log('[SpeechRecognition] Recovered ghost words:', recovered);
            setGhostWords(prev => [...prev, ...recovered]);
          }
        }

        finalWords.forEach((text: string) => {
          newWords.push({
            text,
            timestamp: Date.now(),
            wordId: wordIdCounterRef.current++,
            isGhost: false,
            isFiller: GhostWordTracker.isFillerWord(text)
          });
        });
        newFinalText += transcript + ' ';
        console.log('[SpeechRecognition] Final:', transcript.substring(0, 50));
      } else {
        newInterimText = transcript;
        // Track ghost words in Chrome
        if (browser.isChrome) {
          ghostTrackerRef.current.trackInterimWords(
            transcript.trim().split(/\s+/).filter((w: string) => w.length > 0)
          );
        }
      }
    }

    // Update state with new transcripts
    if (newFinalText) {
      const trimmed = newFinalText.trim();
      setFinalTranscript(prev => (prev ? `${prev} ${trimmed}` : trimmed).trim());
      setRawTranscript(prev => (prev ? `${prev} ${trimmed}` : trimmed).trim());
      setWords(prev => [...prev, ...newWords]);
    }
    setInterimTranscript(newInterimText);
  }, [browser.isChrome, resetSilenceTimeout]);

  // ==================== HANDLER: onerror ====================
  const handleError = useCallback((event: Event) => {
    const e = event as unknown as { error: string; message?: string };
    const errorType = e.error;
    
    console.warn('[SpeechRecognition] Error:', errorType, e.message || '');
    
    // Ignore expected errors
    if (errorType === 'no-speech' || errorType === 'aborted') {
      return;
    }
    
    // Check if we should attempt restart
    if (isRecordingRef.current && !isManualStopRef.current && shouldRestartOnError(errorType)) {
      transientRetryCountRef.current++;
      
      if (transientRetryCountRef.current <= MAX_TRANSIENT_RETRIES) {
        console.log(`[SpeechRecognition] Transient error, retrying (${transientRetryCountRef.current}/${MAX_TRANSIENT_RETRIES})`);
        safeRestartRef.current();
        return;
      }
    }
    
    // Track consecutive failures
    consecutiveFailuresRef.current++;
    
    // Only show error to user if critical
    if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_FAILURES) {
      setError(new Error(`Speech recognition error: ${errorType}`));
    }
  }, [shouldRestartOnError]);

  // ==================== HANDLER: onend ====================
  const handleEnd = useCallback(() => {
    console.log('[SpeechRecognition] onend fired', {
      isRecording: isRecordingRef.current,
      isManualStop: isManualStopRef.current,
      isRestarting: isRestartingRef.current
    });
    
    // If user stopped or we're in manual stop mode, don't restart
    if (!isRecordingRef.current || isManualStopRef.current) {
      return;
    }
    
    // If we're in the middle of a planned restart cycle, handle the delayed restart
    if (isRestartingRef.current) {
      // Edge-specific: wait for late results before restarting
      const delay = browser.isEdge ? 300 : RESTART_DELAY_MS;
      
      setTimeout(() => {
        if (!isRecordingRef.current || isManualStopRef.current) {
          isRestartingRef.current = false;
          return;
        }
        
        isRestartingRef.current = false;
        sessionStartRef.current = Date.now();
        
        if (recognitionRef.current) {
          try {
            recognitionRef.current.start();
            console.log('[SpeechRecognition] Restarted after controlled cycle');
            transientRetryCountRef.current = 0;
          } catch (err) {
            console.error('[SpeechRecognition] Restart failed:', err);
            consecutiveFailuresRef.current++;
          }
        }
      }, delay);
      return;
    }
    
    // Unexpected end - browser cutoff - restart with delay
    console.log('[SpeechRecognition] Unexpected end detected, scheduling restart...');
    isRestartingRef.current = true;
    
    // Edge-specific: wait for late results
    const delay = browser.isEdge ? 300 : RESTART_DELAY_MS;
    
    setTimeout(() => {
      if (!isRecordingRef.current || isManualStopRef.current) {
        isRestartingRef.current = false;
        return;
      }
      
      isRestartingRef.current = false;
      sessionStartRef.current = Date.now();
      
      if (recognitionRef.current) {
        try {
          recognitionRef.current.start();
          console.log('[SpeechRecognition] Restarted after unexpected end');
          transientRetryCountRef.current = 0;
        } catch (err) {
          console.error('[SpeechRecognition] Restart failed:', err);
          consecutiveFailuresRef.current++;
        }
      }
    }, delay);
  }, [browser.isEdge]);

  // ==================== HANDLER: onstart ====================
  const handleStart = useCallback(() => {
    console.log('[SpeechRecognition] onstart fired');
    if (!isListening) {
      setIsListening(true);
      setError(null);
    }
  }, [isListening]);

  // ==================== ATTACH HANDLERS (once per instance) ====================
  const attachHandlers = useCallback((recognition: SpeechRecognitionType) => {
    recognition.onresult = handleResult;
    recognition.onerror = handleError;
    recognition.onend = handleEnd;
    recognition.onstart = handleStart;
  }, [handleResult, handleError, handleEnd, handleStart]);

  // ==================== WATCHDOG TIMER ====================
  // Proactively restarts before Chrome's cutoff AND detects wedged state
  useEffect(() => {
    // Clear existing watchdog
    if (watchdogTimerRef.current) {
      clearInterval(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
    
    if (!isListening) {
      return;
    }
    
    const maxSessionMs = browser.isChrome ? CHROME_MAX_SESSION_MS : EDGE_MAX_SESSION_MS;
    
    watchdogTimerRef.current = setInterval(() => {
      if (!isRecordingRef.current || isManualStopRef.current) {
        return;
      }
      
      const now = Date.now();
      const elapsed = now - sessionStartRef.current;
      const sinceLastResult = now - (lastResultAtRef.current || sessionStartRef.current);
      
      // PROACTIVE RESTART: Before browser's cutoff
      if (elapsed > maxSessionMs) {
        console.log(`[SpeechRecognition] Watchdog: Proactive restart after ${Math.round(elapsed / 1000)}s`);
        safeRestartRef.current();
        return;
      }
      
      // WEDGE DETECTION: No results for too long (but session hasn't timed out)
      // This catches Chrome's silent cutoff bug where it stops emitting results
      if (sinceLastResult > MAX_SILENCE_BEFORE_RESTART_MS && elapsed > 5000) {
        console.warn(`[SpeechRecognition] Watchdog: No results for ${Math.round(sinceLastResult / 1000)}s, forcing restart`);
        safeRestartRef.current();
        return;
      }
    }, WATCHDOG_INTERVAL_MS);
    
    return () => {
      if (watchdogTimerRef.current) {
        clearInterval(watchdogTimerRef.current);
        watchdogTimerRef.current = null;
      }
    };
  }, [isListening, browser.isChrome]);

  // ==================== PUBLIC: startListening ====================
  const startListening = useCallback(() => {
    if (!isSupported) {
      setError(new Error('Speech recognition not supported'));
      return;
    }
    
    console.log('[SpeechRecognition] Starting...');
    
    // Create single instance for this session
    const recognition = createRecognitionInstance();
    if (!recognition) {
      setError(new Error('Failed to create speech recognition'));
      return;
    }
    
    // Attach handlers ONCE
    attachHandlers(recognition);
    recognitionRef.current = recognition;
    
    // Reset all state
    isManualStopRef.current = false;
    isRecordingRef.current = true;
    isRestartingRef.current = false;
    consecutiveFailuresRef.current = 0;
    transientRetryCountRef.current = 0;
    lastProcessedTextRef.current = new Set();
    lastFinalTextRef.current = '';
    wordIdCounterRef.current = 0;
    
    // Timing
    const now = Date.now();
    sessionStartRef.current = now;
    overallStartRef.current = now;
    lastResultAtRef.current = now;
    
    // Helpers
    pauseTrackerRef.current.start();
    ghostTrackerRef.current.reset();
    
    // Start recognition
    try {
      recognition.start();
      resetSilenceTimeout();
      console.log('[SpeechRecognition] Started successfully');
    } catch (err) {
      console.error('[SpeechRecognition] Failed to start:', err);
      setError(err instanceof Error ? err : new Error('Failed to start speech recognition'));
    }
  }, [isSupported, createRecognitionInstance, attachHandlers, resetSilenceTimeout]);

  // ==================== PUBLIC: stopListening ====================
  const stopListening = useCallback(() => {
    console.log('[SpeechRecognition] Stopping...');
    
    // Set flags FIRST to prevent any restart attempts
    isManualStopRef.current = true;
    isRecordingRef.current = false;
    
    // Clear timers
    if (watchdogTimerRef.current) {
      clearInterval(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    
    // Stop recognition gracefully
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Already stopped
      }
    }
    
    setIsListening(false);
    pauseTrackerRef.current.stop();
    setPauseMetrics(pauseTrackerRef.current.getMetrics());
    
    console.log('[SpeechRecognition] Stopped');
  }, []);

  // ==================== PUBLIC: abort ====================
  const abort = useCallback(() => {
    console.log('[SpeechRecognition] Aborting...');
    
    isManualStopRef.current = true;
    isRecordingRef.current = false;
    
    if (watchdogTimerRef.current) {
      clearInterval(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {
        // Already stopped
      }
      recognitionRef.current = null;
    }
    
    setIsListening(false);
  }, []);

  // ==================== PUBLIC: clearTranscript ====================
  const clearTranscript = useCallback(() => {
    setRawTranscript('');
    setFinalTranscript('');
    setInterimTranscript('');
    setWords([]);
    setGhostWords([]);
    setPauseMetrics(null);
    setSessionDuration(0);
    wordIdCounterRef.current = 0;
    lastProcessedTextRef.current = new Set();
    lastFinalTextRef.current = '';
    ghostTrackerRef.current.reset();
    pauseTrackerRef.current.reset();
  }, []);

  // ==================== PUBLIC: setAccent ====================
  const setAccent = useCallback((accent: string) => {
    setSelectedAccent(accent);
    setStoredAccent(accent);
    
    // For Chrome, restart with new accent if currently listening
    if (browser.isChrome && isListening) {
      stopListening();
      setTimeout(() => startListening(), 300);
    }
  }, [browser.isChrome, isListening, stopListening, startListening]);

  // ==================== RETURN ====================
  return {
    isListening,
    isSupported,
    error,
    rawTranscript,
    finalTranscript,
    interimTranscript,
    words,
    ghostWords,
    pauseMetrics,
    sessionDuration,
    browser,
    startListening,
    stopListening,
    abort,
    clearTranscript,
    selectedAccent,
    setAccent
  };
}
