/**
 * Advanced Speech Analysis Hook
 * Orchestrates browser-adaptive speech recognition and audio analysis for text-based evaluation
 * 
 * BROWSER-ADAPTIVE DESIGN:
 * - Edge: Natural mode (no forced language), preserves fillers and pauses
 * - Chrome: Forced accent for stability, ghost word tracking, seamless overlap cycling
 * 
 * KEY FIX: Uses OVERLAPPING recognition instances to eliminate gaps during cycling/restarts
 */

import { useState, useRef, useCallback } from 'react';
import { AudioFeatureExtractor, AudioAnalysisResult } from '@/lib/audioFeatureExtractor';
import { analyzeProsody, ProsodyMetrics, createEmptyProsodyMetrics } from '@/lib/prosodyAnalyzer';
import { WordConfidenceTracker, WordConfidence } from '@/lib/wordConfidenceTracker';
import { calculateFluency, FluencyMetrics, createEmptyFluencyMetrics } from '@/lib/fluencyCalculator';
import {
  detectBrowser,
  PauseTracker,
  GhostWordTracker,
  getStoredAccent,
  BrowserInfo
} from '@/lib/speechRecognition';

export interface SpeechAnalysisResult {
  rawTranscript: string;           // What browser heard (with fillers, for fluency)
  cleanedTranscript: string;       // Fillers removed (for vocab/grammar)
  wordConfidences: WordConfidence[];
  fluencyMetrics: FluencyMetrics;
  prosodyMetrics: ProsodyMetrics;
  audioAnalysis: AudioAnalysisResult;
  durationMs: number;
  overallClarityScore: number;     // 0-100
  // Browser-adaptive additions
  ghostWords: string[];            // Recovered filler words (Chrome only)
  pauseBreakdowns: number;         // Number of significant pauses
  browserMode: 'edge-natural' | 'chrome-accent' | 'other';
}

interface UseAdvancedSpeechAnalysisOptions {
  language?: string;
  onInterimResult?: (transcript: string) => void;
  onError?: (error: Error) => void;
  onGhostWordRecovered?: (word: string) => void;
}

// Browser SpeechRecognition types
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: {
    isFinal: boolean;
    [index: number]: { transcript: string };
  };
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  [index: number]: { transcript: string };
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message?: string;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onstart: (() => void) | null;
  onend: (() => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognition;
    webkitSpeechRecognition: new () => SpeechRecognition;
  }
}

// CRITICAL: Chrome cycle interval BEFORE Chrome's ~45-second cutoff
// Using 35 seconds for safety margin
const CHROME_CYCLE_INTERVAL_MS = 35000;

// Edge cycle interval - Edge has longer tolerance but still needs cycling
// Using 55 seconds to be safe
const EDGE_CYCLE_INTERVAL_MS = 55000;

// Overlap duration: how long both instances run together during transition
// This ensures no speech is lost during the handoff
const OVERLAP_DURATION_MS = 3000;

// Maximum consecutive restart attempts before giving up
const MAX_CONSECUTIVE_FAILURES = 10;

export function useAdvancedSpeechAnalysis(options: UseAdvancedSpeechAnalysisOptions = {}) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [isSupported, setIsSupported] = useState(true);
  const [currentRms, setCurrentRms] = useState(0);

  // Browser detection
  const browserRef = useRef<BrowserInfo>(detectBrowser());
  
  const audioExtractorRef = useRef<AudioFeatureExtractor | null>(null);
  const wordTrackerRef = useRef<WordConfidenceTracker | null>(null);
  
  // DUAL RECOGNITION INSTANCES for seamless overlap transitions
  const primaryRecognitionRef = useRef<SpeechRecognition | null>(null);
  const secondaryRecognitionRef = useRef<SpeechRecognition | null>(null);
  const activeInstanceRef = useRef<'primary' | 'secondary'>('primary');
  
  const finalTranscriptRef = useRef('');
  const startTimeRef = useRef(0);
  const isAnalyzingRef = useRef(false);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const rmsMonitorRef = useRef<number | null>(null);
  
  // Browser-adaptive tracking
  const pauseTrackerRef = useRef<PauseTracker | null>(null);
  const ghostTrackerRef = useRef<GhostWordTracker | null>(null);
  const ghostWordsRef = useRef<string[]>([]);
  const cycleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const consecutiveFailuresRef = useRef(0);
  const lastProcessedTextRef = useRef(new Set<string>());
  const lastFinalTextRef = useRef('');
  
  // Store the language for dynamic updates
  const languageRef = useRef(options.language || getStoredAccent());
  
  // Update language ref when options change
  if (options.language && options.language !== languageRef.current) {
    languageRef.current = options.language;
  }

  /**
   * Create a new speech recognition instance with browser-specific configuration
   */
  const createRecognitionInstance = useCallback((): SpeechRecognition | null => {
    const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionClass) return null;
    
    const browser = browserRef.current;
    const recognition = new SpeechRecognitionClass();
    
    recognition.continuous = true;
    recognition.interimResults = true;
    
    // CRITICAL: Browser-specific language configuration
    if (browser.isEdge) {
      // EDGE: DO NOT set lang - preserves fillers and natural punctuation
      console.log('[SpeechAnalysis] Creating Edge instance: Natural mode');
    } else if (browser.isChrome) {
      // CHROME: Force accent for stability
      recognition.lang = languageRef.current;
      console.log(`[SpeechAnalysis] Creating Chrome instance: ${recognition.lang}`);
    } else {
      recognition.lang = languageRef.current;
    }
    
    return recognition;
  }, []);

  /**
   * Handle speech recognition results from any instance
   */
  const handleResult = useCallback((event: SpeechRecognitionEvent, instanceId: string) => {
    if (!isAnalyzingRef.current) return;
    
    const browser = browserRef.current;
    
    // Record speech event for pause tracking
    pauseTrackerRef.current?.recordSpeechEvent();
    
    // Reset failure counter on successful result
    consecutiveFailuresRef.current = 0;
    
    let interimText = '';
    let newFinalText = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0].transcript;

      if (result.isFinal) {
        // CRITICAL: Deduplicate across all instances using text content
        const normalizedText = text.trim().toLowerCase();
        if (lastProcessedTextRef.current.has(normalizedText) || text === lastFinalTextRef.current) {
          console.log(`[SpeechAnalysis] Skipping duplicate from ${instanceId}:`, text.substring(0, 30));
          continue;
        }
        
        lastProcessedTextRef.current.add(normalizedText);
        lastFinalTextRef.current = text;
        
        // Keep set size manageable (last 50 texts)
        if (lastProcessedTextRef.current.size > 50) {
          const entries = Array.from(lastProcessedTextRef.current);
          lastProcessedTextRef.current = new Set(entries.slice(-30));
        }
        
        // CHROME: Extract ghost words before they disappear
        if (browser.isChrome && ghostTrackerRef.current) {
          const finalWords = text.trim().split(/\s+/).filter((w: string) => w.length > 0);
          const finalWordsSet = new Set<string>(finalWords.map((w: string) => w.toLowerCase()));
          const recovered = ghostTrackerRef.current.extractAcceptedGhosts(finalWordsSet);
          
          if (recovered.length > 0) {
            console.log('[SpeechAnalysis] Recovered ghost words:', recovered);
            ghostWordsRef.current.push(...recovered);
            recovered.forEach(word => options.onGhostWordRecovered?.(word));
          }
        }
        
        newFinalText += text + ' ';
        wordTrackerRef.current?.addSnapshot(text, true);
        console.log(`[SpeechAnalysis] Final from ${instanceId}:`, text.substring(0, 50));
      } else {
        interimText += text;
        wordTrackerRef.current?.addSnapshot(text, false);
        
        // CHROME: Track interim words for ghost detection
        if (browser.isChrome && ghostTrackerRef.current) {
          const interimWords = text.trim().split(/\s+/).filter((w: string) => w.length > 0);
          ghostTrackerRef.current.trackInterimWords(interimWords);
        }
      }
    }

    if (newFinalText) {
      finalTranscriptRef.current += newFinalText;
    }

    const combined = finalTranscriptRef.current + interimText;
    setInterimTranscript(combined);
    options.onInterimResult?.(combined);
  }, [options]);

  /**
   * Handle recognition errors
   */
  const handleError = useCallback((event: SpeechRecognitionErrorEvent, instanceId: string) => {
    if (event.error !== 'no-speech' && event.error !== 'aborted') {
      console.warn(`[SpeechAnalysis] Error from ${instanceId}:`, event.error);
      consecutiveFailuresRef.current++;
      
      if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_FAILURES) {
        const err = new Error(`Speech recognition failed repeatedly: ${event.error}`);
        setError(err);
        options.onError?.(err);
      }
    }
  }, [options]);

  /**
   * Handle recognition end with automatic restart
   */
  const handleEnd = useCallback((recognition: SpeechRecognition, instanceId: string) => {
    if (!isAnalyzingRef.current) return;
    
    console.log(`[SpeechAnalysis] Instance ${instanceId} ended, restarting...`);
    
    // Immediate restart attempt
    setTimeout(() => {
      if (isAnalyzingRef.current && recognition) {
        try {
          recognition.start();
          console.log(`[SpeechAnalysis] Instance ${instanceId} restarted`);
        } catch (err) {
          console.warn(`[SpeechAnalysis] Restart failed for ${instanceId}:`, err);
        }
      }
    }, 50); // Minimal delay for restart
  }, []);

  /**
   * Setup event handlers for a recognition instance
   */
  const setupRecognitionHandlers = useCallback((recognition: SpeechRecognition, instanceId: string) => {
    recognition.onresult = (event: SpeechRecognitionEvent) => handleResult(event, instanceId);
    recognition.onerror = (event: SpeechRecognitionErrorEvent) => handleError(event, instanceId);
    recognition.onend = () => handleEnd(recognition, instanceId);
  }, [handleResult, handleError, handleEnd]);

  /**
   * Seamless overlap cycle: Start new instance BEFORE stopping old one
   * This ensures no gap in speech capture
   */
  const performSeamlessCycle = useCallback(() => {
    if (!isAnalyzingRef.current) return;
    
    const browser = browserRef.current;
    const currentActive = activeInstanceRef.current;
    const nextActive = currentActive === 'primary' ? 'secondary' : 'primary';
    
    console.log(`[SpeechAnalysis] Starting seamless cycle: ${currentActive} -> ${nextActive}`);
    
    // Create and start the new instance FIRST
    const newRecognition = createRecognitionInstance();
    if (!newRecognition) {
      console.error('[SpeechAnalysis] Failed to create new recognition instance');
      return;
    }
    
    setupRecognitionHandlers(newRecognition, nextActive);
    
    try {
      newRecognition.start();
      console.log(`[SpeechAnalysis] New instance ${nextActive} started`);
      
      // Store the new instance
      if (nextActive === 'primary') {
        primaryRecognitionRef.current = newRecognition;
      } else {
        secondaryRecognitionRef.current = newRecognition;
      }
      
      // After overlap period, stop the old instance
      setTimeout(() => {
        if (!isAnalyzingRef.current) return;
        
        const oldRecognition = currentActive === 'primary' 
          ? primaryRecognitionRef.current 
          : secondaryRecognitionRef.current;
        
        if (oldRecognition) {
          try {
            oldRecognition.abort();
            console.log(`[SpeechAnalysis] Old instance ${currentActive} stopped`);
          } catch {
            // Already stopped
          }
        }
        
        // Update active instance reference
        activeInstanceRef.current = nextActive;
        
      }, OVERLAP_DURATION_MS);
      
    } catch (err) {
      console.error('[SpeechAnalysis] Failed to start new instance:', err);
    }
    
    // Schedule next cycle
    const cycleInterval = browser.isChrome ? CHROME_CYCLE_INTERVAL_MS : EDGE_CYCLE_INTERVAL_MS;
    scheduleCycle(cycleInterval);
  }, [createRecognitionInstance, setupRecognitionHandlers]);

  /**
   * Schedule the next seamless cycle
   */
  const scheduleCycle = useCallback((intervalMs: number) => {
    if (cycleTimerRef.current) {
      clearTimeout(cycleTimerRef.current);
    }
    
    cycleTimerRef.current = setTimeout(() => {
      if (isAnalyzingRef.current) {
        performSeamlessCycle();
      }
    }, intervalMs);
  }, [performSeamlessCycle]);

  const start = useCallback(async (stream: MediaStream) => {
    const browser = browserRef.current;
    console.log(`[SpeechAnalysis] Starting with browser: ${browser.browserName}`);
    
    // Check browser support
    const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionClass) {
      setIsSupported(false);
      setError(new Error('Speech recognition not supported in this browser'));
      return false;
    }

    setError(null);
    setIsAnalyzing(true);
    isAnalyzingRef.current = true;
    setInterimTranscript('');
    setCurrentRms(0);
    finalTranscriptRef.current = '';
    startTimeRef.current = Date.now();
    ghostWordsRef.current = [];
    consecutiveFailuresRef.current = 0;
    lastProcessedTextRef.current = new Set();
    lastFinalTextRef.current = '';
    activeInstanceRef.current = 'primary';

    // Request screen wake lock
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
        console.log('[SpeechAnalysis] Wake lock acquired');
      }
    } catch (err) {
      console.warn('[SpeechAnalysis] Wake lock not available:', err);
    }

    // Initialize browser-adaptive trackers
    pauseTrackerRef.current = new PauseTracker();
    pauseTrackerRef.current.start();
    
    if (browser.isChrome) {
      ghostTrackerRef.current = new GhostWordTracker();
    }

    // Start audio feature extraction
    audioExtractorRef.current = new AudioFeatureExtractor();
    await audioExtractorRef.current.start(stream);

    // Start RMS monitoring
    rmsMonitorRef.current = window.setInterval(() => {
      const frames = audioExtractorRef.current?.getRecentFrames?.(5) || [];
      if (frames.length > 0) {
        const avgRms = frames.reduce((sum, f) => sum + f.rms, 0) / frames.length;
        setCurrentRms(avgRms);
      }
    }, 200);

    // Start word confidence tracking
    wordTrackerRef.current = new WordConfidenceTracker();
    wordTrackerRef.current.start();

    // Create and start primary recognition instance
    const primaryRecognition = createRecognitionInstance();
    if (!primaryRecognition) {
      setError(new Error('Failed to create speech recognition'));
      return false;
    }
    
    setupRecognitionHandlers(primaryRecognition, 'primary');
    primaryRecognitionRef.current = primaryRecognition;
    
    try {
      primaryRecognition.start();
      console.log('[SpeechAnalysis] Primary instance started');
      
      // Schedule first seamless cycle
      const cycleInterval = browser.isChrome ? CHROME_CYCLE_INTERVAL_MS : EDGE_CYCLE_INTERVAL_MS;
      scheduleCycle(cycleInterval);
      
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to start speech recognition'));
      return false;
    }

    return true;
  }, [options, createRecognitionInstance, setupRecognitionHandlers, scheduleCycle]);

  const stop = useCallback((): SpeechAnalysisResult | null => {
    const browser = browserRef.current;
    
    console.log('[SpeechAnalysis] Stopping...');
    
    setIsAnalyzing(false);
    isAnalyzingRef.current = false;
    setCurrentRms(0);

    // Clear cycle timer
    if (cycleTimerRef.current) {
      clearTimeout(cycleTimerRef.current);
      cycleTimerRef.current = null;
    }

    // Stop RMS monitor
    if (rmsMonitorRef.current) {
      clearInterval(rmsMonitorRef.current);
      rmsMonitorRef.current = null;
    }

    // Release wake lock
    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
      console.log('[SpeechAnalysis] Wake lock released');
    }

    // Stop BOTH recognition instances
    [primaryRecognitionRef.current, secondaryRecognitionRef.current].forEach((recognition, idx) => {
      if (recognition) {
        try {
          recognition.abort();
          console.log(`[SpeechAnalysis] Instance ${idx === 0 ? 'primary' : 'secondary'} stopped`);
        } catch {
          // Already stopped
        }
      }
    });
    primaryRecognitionRef.current = null;
    secondaryRecognitionRef.current = null;

    // Get pause metrics
    pauseTrackerRef.current?.stop();
    const pauseMetrics = pauseTrackerRef.current?.getMetrics();

    // Get audio analysis results
    const audioAnalysis = audioExtractorRef.current?.stop() || AudioFeatureExtractor.createEmptyResult();
    const prosodyMetrics = analyzeProsody(audioAnalysis);

    // Get final transcript (include ghost words for raw transcript)
    const baseTranscript = finalTranscriptRef.current.trim() || interimTranscript.trim();
    
    // Build raw transcript with recovered ghost words
    const ghostWords = ghostWordsRef.current;
    const rawTranscript = ghostWords.length > 0 
      ? `${baseTranscript} [recovered: ${ghostWords.join(', ')}]`
      : baseTranscript;

    // Silence Safety Gate
    const isSilentAudio = audioAnalysis.silenceRatio > 0.95 && audioAnalysis.averageRms < 0.01;
    if (isSilentAudio && rawTranscript.length > 0) {
      console.warn('[SpeechAnalysis] Silent audio with text detected - possible hallucination, discarding');
      return null;
    }

    if (!baseTranscript) {
      return null;
    }

    // Calculate word confidences
    const wordConfidences = wordTrackerRef.current?.getWordConfidences(baseTranscript) || 
                            WordConfidenceTracker.createEmptyConfidences(baseTranscript);

    const durationMs = Date.now() - startTimeRef.current;

    const fluencyMetrics = calculateFluency(
      wordConfidences,
      audioAnalysis,
      prosodyMetrics,
      durationMs
    );

    // Create cleaned transcript
    const cleanedTranscript = wordConfidences
      .filter(w => !w.isFiller && !w.isRepeat)
      .map(w => w.word)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Calculate clarity score
    const avgConfidence = wordConfidences.length > 0
      ? wordConfidences.reduce((sum, w) => sum + w.confidence, 0) / wordConfidences.length
      : 0;

    const overallClarityScore = Math.round(
      (avgConfidence * 0.4) + 
      (fluencyMetrics.overallFluencyScore * 0.3) + 
      (prosodyMetrics.pitchVariation * 0.15) +
      (prosodyMetrics.rhythmConsistency * 0.15)
    );

    // Determine browser mode
    let browserMode: SpeechAnalysisResult['browserMode'] = 'other';
    if (browser.isEdge) browserMode = 'edge-natural';
    else if (browser.isChrome) browserMode = 'chrome-accent';

    console.log(`[SpeechAnalysis] Complete. Duration: ${durationMs}ms, Words: ${wordConfidences.length}`);

    return {
      rawTranscript,
      cleanedTranscript,
      wordConfidences,
      fluencyMetrics,
      prosodyMetrics,
      audioAnalysis,
      durationMs,
      overallClarityScore,
      ghostWords,
      pauseBreakdowns: pauseMetrics?.fluencyBreakdowns || 0,
      browserMode,
    };
  }, [interimTranscript]);

  const abort = useCallback(() => {
    console.log('[SpeechAnalysis] Aborting...');
    
    setIsAnalyzing(false);
    isAnalyzingRef.current = false;
    setCurrentRms(0);

    if (cycleTimerRef.current) {
      clearTimeout(cycleTimerRef.current);
      cycleTimerRef.current = null;
    }

    if (rmsMonitorRef.current) {
      clearInterval(rmsMonitorRef.current);
      rmsMonitorRef.current = null;
    }

    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
    }

    // Abort both instances
    [primaryRecognitionRef.current, secondaryRecognitionRef.current].forEach(recognition => {
      if (recognition) {
        try {
          recognition.abort();
        } catch {
          // Already stopped
        }
      }
    });
    primaryRecognitionRef.current = null;
    secondaryRecognitionRef.current = null;

    if (audioExtractorRef.current) {
      audioExtractorRef.current.stop();
      audioExtractorRef.current = null;
    }

    pauseTrackerRef.current = null;
    ghostTrackerRef.current = null;
    wordTrackerRef.current = null;
  }, []);

  // Exports for backward compatibility and fluency calculations
  const getEmptyFluencyMetrics = useCallback(() => createEmptyFluencyMetrics(), []);
  const getEmptyProsodyMetrics = useCallback(() => createEmptyProsodyMetrics(), []);

  return {
    isAnalyzing,
    isSupported,
    error,
    interimTranscript,
    currentRms,
    start,
    stop,
    abort,
    getEmptyFluencyMetrics,
    getEmptyProsodyMetrics,
  };
}

/**
 * Create an empty speech analysis result for fallback scenarios
 */
export function createEmptySpeechAnalysisResult(): SpeechAnalysisResult {
  return {
    rawTranscript: '',
    cleanedTranscript: '',
    wordConfidences: [],
    fluencyMetrics: createEmptyFluencyMetrics(),
    prosodyMetrics: createEmptyProsodyMetrics(),
    audioAnalysis: AudioFeatureExtractor.createEmptyResult(),
    durationMs: 0,
    overallClarityScore: 0,
    ghostWords: [],
    pauseBreakdowns: 0,
    browserMode: 'other',
  };
}
