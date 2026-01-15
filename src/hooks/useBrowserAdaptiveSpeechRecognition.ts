/**
 * Browser-Adaptive Speech Recognition Hook
 * 
 * CRITICAL DESIGN PRINCIPLE:
 * Edge and Chrome are treated as DIFFERENT speech engines.
 * 
 * - Edge: Natural mode, no forced language, preserves fillers
 * - Chrome: Forced accent for stability, ghost word tracking enabled
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
  
  const recognitionRef = useRef<SpeechRecognitionType | null>(null);
  const isManualStopRef = useRef(false);
  const restartAttemptRef = useRef(0);
  const lastProcessedIndexRef = useRef(-1);
  const lastFinalTextRef = useRef('');
  const wordIdCounterRef = useRef(0);
  const sessionStartTimeRef = useRef(0);
  const chromeCycleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pauseTrackerRef = useRef(new PauseTracker());
  const ghostTrackerRef = useRef(new GhostWordTracker());
  
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    if (isListening && sessionStartTimeRef.current > 0) {
      interval = setInterval(() => setSessionDuration(Date.now() - sessionStartTimeRef.current), 1000);
    }
    return () => { if (interval) clearInterval(interval); };
  }, [isListening]);
  
  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      if (chromeCycleTimerRef.current) clearTimeout(chromeCycleTimerRef.current);
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    };
  }, []);

  const resetSilenceTimeout = useCallback(() => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = setTimeout(() => {
      if (isListening && !isManualStopRef.current) {
        setError(new Error('No speech detected for extended period'));
      }
    }, mergedConfig.silenceTimeoutMs);
  }, [isListening, mergedConfig.silenceTimeoutMs]);

  const scheduleChromeRecycle = useCallback(() => {
    if (!browser.isChrome) return;
    if (chromeCycleTimerRef.current) clearTimeout(chromeCycleTimerRef.current);
    chromeCycleTimerRef.current = setTimeout(() => {
      if (isListening && !isManualStopRef.current && recognitionRef.current) {
        recognitionRef.current.stop();
        setTimeout(() => {
          if (!isManualStopRef.current && recognitionRef.current) {
            try { recognitionRef.current.start(); scheduleChromeRecycle(); } catch {}
          }
        }, 200);
      }
    }, mergedConfig.chromeCycleIntervalMs);
  }, [browser.isChrome, isListening, mergedConfig.chromeCycleIntervalMs]);

  const createRecognition = useCallback(() => {
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) return null;
    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = true;
    recognition.interimResults = true;
    if (browser.isEdge) {
      // Edge: DO NOT set lang - preserves fillers
    } else if (browser.isChrome) {
      recognition.lang = selectedAccent;
    } else {
      recognition.lang = selectedAccent;
    }
    return recognition;
  }, [browser.isEdge, browser.isChrome, selectedAccent]);

  const handleResult = useCallback((event: Event) => {
    const e = event as unknown as { resultIndex: number; results: SpeechRecognitionResultList };
    resetSilenceTimeout();
    pauseTrackerRef.current.recordSpeechEvent();
    restartAttemptRef.current = 0;
    if (e.resultIndex <= lastProcessedIndexRef.current) return;
    
    let newFinalText = '';
    let newInterimText = '';
    const newWords: TranscriptState['words'] = [];
    
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      const transcript = result[0].transcript;
      if (result.isFinal) {
        if (transcript === lastFinalTextRef.current) continue;
        lastFinalTextRef.current = transcript;
        lastProcessedIndexRef.current = i;
        const finalWords = transcript.trim().split(/\s+/).filter((w: string) => w.length > 0);
        const finalWordsSet = new Set<string>(finalWords.map((w: string) => w.toLowerCase()));
        if (browser.isChrome) {
          const recovered = ghostTrackerRef.current.extractAcceptedGhosts(finalWordsSet);
          if (recovered.length > 0) setGhostWords(prev => [...prev, ...recovered]);
        }
        finalWords.forEach((text: string) => {
          newWords.push({ text, timestamp: Date.now(), wordId: wordIdCounterRef.current++, isGhost: false, isFiller: GhostWordTracker.isFillerWord(text) });
        });
        newFinalText += transcript + ' ';
      } else {
        newInterimText = transcript;
        if (browser.isChrome) {
          ghostTrackerRef.current.trackInterimWords(transcript.trim().split(/\s+/).filter((w: string) => w.length > 0));
        }
      }
    }
    if (newFinalText) {
      const trimmed = newFinalText.trim();
      setFinalTranscript(prev => (prev ? `${prev} ${trimmed}` : trimmed).trim());
      setRawTranscript(prev => (prev ? `${prev} ${trimmed}` : trimmed).trim());
      setWords(prev => [...prev, ...newWords]);
    }
    setInterimTranscript(newInterimText);
  }, [browser.isChrome, resetSilenceTimeout]);

  const handleError = useCallback((event: Event) => {
    const e = event as unknown as { error: string };
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    setError(new Error(`Speech recognition error: ${e.error}`));
  }, []);

  const handleEnd = useCallback(() => {
    setInterimTranscript('');
    if (!isManualStopRef.current && isListening) {
      if (restartAttemptRef.current < mergedConfig.maxRestartAttempts) {
        restartAttemptRef.current++;
        setTimeout(() => { try { recognitionRef.current?.start(); } catch {} }, 100);
      } else {
        setIsListening(false);
        setError(new Error('Speech recognition stopped unexpectedly'));
      }
    } else {
      setIsListening(false);
      pauseTrackerRef.current.stop();
      setPauseMetrics(pauseTrackerRef.current.getMetrics());
    }
  }, [isListening, mergedConfig.maxRestartAttempts]);

  const startListening = useCallback(() => {
    if (!isSupported) { setError(new Error('Speech recognition not supported')); return; }
    const recognition = createRecognition();
    if (!recognition) { setError(new Error('Failed to create speech recognition')); return; }
    recognition.onresult = handleResult;
    recognition.onerror = handleError;
    recognition.onend = handleEnd;
    recognition.onstart = () => { setIsListening(true); setError(null); };
    recognitionRef.current = recognition;
    isManualStopRef.current = false;
    restartAttemptRef.current = 0;
    lastProcessedIndexRef.current = -1;
    lastFinalTextRef.current = '';
    sessionStartTimeRef.current = Date.now();
    pauseTrackerRef.current.start();
    ghostTrackerRef.current.reset();
    try { recognition.start(); resetSilenceTimeout(); if (browser.isChrome) scheduleChromeRecycle(); } catch (err) { setError(err instanceof Error ? err : new Error('Failed to start')); }
  }, [isSupported, createRecognition, handleResult, handleError, handleEnd, resetSilenceTimeout, browser.isChrome, scheduleChromeRecycle]);

  const stopListening = useCallback(() => {
    isManualStopRef.current = true;
    if (chromeCycleTimerRef.current) clearTimeout(chromeCycleTimerRef.current);
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    recognitionRef.current?.stop();
    setIsListening(false);
    pauseTrackerRef.current.stop();
    setPauseMetrics(pauseTrackerRef.current.getMetrics());
  }, []);

  const abort = useCallback(() => {
    isManualStopRef.current = true;
    if (chromeCycleTimerRef.current) clearTimeout(chromeCycleTimerRef.current);
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    recognitionRef.current?.abort();
    setIsListening(false);
  }, []);

  const clearTranscript = useCallback(() => {
    setRawTranscript(''); setFinalTranscript(''); setInterimTranscript(''); setWords([]); setGhostWords([]); setPauseMetrics(null); setSessionDuration(0);
    wordIdCounterRef.current = 0; ghostTrackerRef.current.reset(); pauseTrackerRef.current.reset();
  }, []);

  const setAccent = useCallback((accent: string) => {
    setSelectedAccent(accent); setStoredAccent(accent);
    if (browser.isChrome && isListening) { stopListening(); setTimeout(() => startListening(), 200); }
  }, [browser.isChrome, isListening, stopListening, startListening]);

  return { isListening, isSupported, error, rawTranscript, finalTranscript, interimTranscript, words, ghostWords, pauseMetrics, sessionDuration, browser, startListening, stopListening, abort, clearTranscript, selectedAccent, setAccent };
}
