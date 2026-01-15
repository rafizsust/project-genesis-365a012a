/**
 * Simple Speech Recognition Hook
 * 
 * SINGLE INSTANCE ARCHITECTURE:
 * - ONE SpeechRecognition instance per session
 * - Controlled self-restart via watchdog
 * - Transcript buffer survives restarts
 * - No dual-instance cycling
 */

import { useState, useRef, useCallback, useEffect } from 'react';

interface SpeechRecognitionConfig {
  language?: string;
  continuous?: boolean;
  interimResults?: boolean;
  onResult?: (transcript: string, isFinal: boolean) => void;
  onError?: (error: Error) => void;
  onStart?: () => void;
  onEnd?: () => void;
}

// Chrome max session before proactive restart (before Chrome's ~45s cutoff)
const CHROME_MAX_SESSION_MS = 35000;
// Edge max session - Edge has longer tolerance
const EDGE_MAX_SESSION_MS = 45000;
// Delay before restarting after stop
const RESTART_DELAY_MS = 250;
// Watchdog check interval
const WATCHDOG_INTERVAL_MS = 2000;

// Browser detection
const detectBrowser = () => {
  const ua = navigator.userAgent;
  const isChrome = ua.includes('Chrome') && !ua.includes('Edg');
  const isEdge = ua.includes('Edg');
  return { isChrome, isEdge };
};

export function useSpeechRecognition(config: SpeechRecognitionConfig = {}) {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [isSupported, setIsSupported] = useState(true);
  
  // SINGLE RECOGNITION INSTANCE - one per session
  const recognitionRef = useRef<InstanceType<typeof window.SpeechRecognition> | null>(null);
  
  // Lifecycle flags
  const isRecordingRef = useRef(false);      // True while user wants to record
  const isRestartingRef = useRef(false);     // True during controlled restart cycle
  const isManualStopRef = useRef(false);     // True when user explicitly stops
  
  // Timing
  const sessionStartRef = useRef(0);         // When current recognition session started
  
  // Watchdog timer
  const watchdogTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  
  // Transcript buffer - survives restarts
  const transcriptBufferRef = useRef('');
  
  // Browser info
  const browserRef = useRef(detectBrowser());

  // DEV ASSERTION: Ensure only one instance exists
  const instanceCountRef = useRef(0);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch { /* ignore */ }
      }
      if (watchdogTimerRef.current) {
        clearInterval(watchdogTimerRef.current);
      }
    };
  }, []);

  // Create recognition instance with handlers
  const createRecognition = useCallback(() => {
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    
    if (!SpeechRecognitionAPI) {
      setIsSupported(false);
      setError(new Error('Speech recognition not supported in this browser'));
      return null;
    }

    // DEV ASSERTION: Check for multiple instances
    instanceCountRef.current++;
    if (instanceCountRef.current > 1) {
      console.error('[SpeechRecognition] CRITICAL: Multiple instances detected!', instanceCountRef.current);
    }

    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = config.continuous ?? true;
    recognition.interimResults = config.interimResults ?? true;
    recognition.lang = config.language ?? 'en-GB';

    recognition.onresult = (event) => {
      if (!isRecordingRef.current) return;
      
      let finalText = '';
      let interimText = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript;
        
        if (result.isFinal) {
          finalText += text + ' ';
          config.onResult?.(text, true);
        } else {
          interimText += text;
          config.onResult?.(text, false);
        }
      }

      if (finalText) {
        transcriptBufferRef.current += finalText;
        setTranscript(transcriptBufferRef.current);
      }
      setInterimTranscript(interimText);
    };

    recognition.onerror = (event) => {
      // Ignore expected errors
      if (event.error === 'no-speech' || event.error === 'aborted') {
        return;
      }
      
      console.warn('[SpeechRecognition] Error:', event.error);
      const err = new Error(`Speech recognition error: ${event.error}`);
      setError(err);
      config.onError?.(err);
    };

    recognition.onstart = () => {
      console.log('[SpeechRecognition] onstart');
      setIsListening(true);
      setError(null);
      config.onStart?.();
    };

    recognition.onend = () => {
      console.log('[SpeechRecognition] onend', {
        isRecording: isRecordingRef.current,
        isRestarting: isRestartingRef.current,
        isManualStop: isManualStopRef.current
      });

      // If user stopped, don't restart
      if (!isRecordingRef.current || isManualStopRef.current) {
        setIsListening(false);
        setInterimTranscript('');
        config.onEnd?.();
        return;
      }

      // If we're in a controlled restart cycle, handle it
      if (isRestartingRef.current) {
        // Edge-specific: wait for late results before restarting
        const delay = browserRef.current.isEdge ? 300 : RESTART_DELAY_MS;
        
        setTimeout(() => {
          if (!isRecordingRef.current || isManualStopRef.current) {
            isRestartingRef.current = false;
            return;
          }
          
          isRestartingRef.current = false;
          sessionStartRef.current = Date.now();
          
          try {
            recognition.start();
            console.log('[SpeechRecognition] Restarted after controlled cycle');
          } catch (err) {
            console.error('[SpeechRecognition] Restart failed:', err);
          }
        }, delay);
        return;
      }

      // Unexpected end (browser cutoff) - restart
      console.log('[SpeechRecognition] Unexpected end, restarting...');
      isRestartingRef.current = true;
      
      const delay = browserRef.current.isEdge ? 300 : RESTART_DELAY_MS;
      setTimeout(() => {
        if (!isRecordingRef.current || isManualStopRef.current) {
          isRestartingRef.current = false;
          return;
        }
        
        isRestartingRef.current = false;
        sessionStartRef.current = Date.now();
        
        try {
          recognition.start();
          console.log('[SpeechRecognition] Restarted after unexpected end');
        } catch (err) {
          console.error('[SpeechRecognition] Restart failed:', err);
        }
      }, delay);
    };

    return recognition;
  }, [config]);

  // Start listening
  const startListening = useCallback(() => {
    console.log('[SpeechRecognition] Starting...');
    
    // Reset instance count for new session
    instanceCountRef.current = 0;
    
    // Create single instance for this session
    const recognition = createRecognition();
    if (!recognition) return;
    
    recognitionRef.current = recognition;
    
    // Reset state
    isManualStopRef.current = false;
    isRecordingRef.current = true;
    isRestartingRef.current = false;
    transcriptBufferRef.current = '';
    sessionStartRef.current = Date.now();
    
    setTranscript('');
    setInterimTranscript('');
    setError(null);
    
    // Start watchdog timer for proactive restarts
    const maxSessionMs = browserRef.current.isChrome ? CHROME_MAX_SESSION_MS : EDGE_MAX_SESSION_MS;
    
    watchdogTimerRef.current = setInterval(() => {
      if (!isRecordingRef.current || isManualStopRef.current || isRestartingRef.current) {
        return;
      }
      
      const elapsed = Date.now() - sessionStartRef.current;
      
      if (elapsed > maxSessionMs) {
        console.log(`[SpeechRecognition] Watchdog: Proactive restart after ${Math.round(elapsed / 1000)}s`);
        isRestartingRef.current = true;
        
        try {
          recognitionRef.current?.stop();
        } catch {
          // Already stopped
        }
      }
    }, WATCHDOG_INTERVAL_MS);

    try {
      recognition.start();
      console.log('[SpeechRecognition] Started');
    } catch (err) {
      console.error('[SpeechRecognition] Start error:', err);
      setError(err instanceof Error ? err : new Error('Failed to start'));
    }
  }, [createRecognition]);

  // Stop listening
  const stopListening = useCallback(() => {
    console.log('[SpeechRecognition] Stopping...');
    
    // Set flags FIRST to prevent restart
    isManualStopRef.current = true;
    isRecordingRef.current = false;
    
    // Clear watchdog
    if (watchdogTimerRef.current) {
      clearInterval(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
    
    // Stop recognition
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Already stopped
      }
    }
    
    setIsListening(false);
    instanceCountRef.current = 0;
    console.log('[SpeechRecognition] Stopped');
  }, []);

  // Abort (immediate stop)
  const abort = useCallback(() => {
    console.log('[SpeechRecognition] Aborting...');
    
    isManualStopRef.current = true;
    isRecordingRef.current = false;
    
    if (watchdogTimerRef.current) {
      clearInterval(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
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
    instanceCountRef.current = 0;
  }, []);

  // Clear transcript
  const clearTranscript = useCallback(() => {
    transcriptBufferRef.current = '';
    setTranscript('');
    setInterimTranscript('');
  }, []);

  return {
    isListening,
    isSupported,
    transcript,
    interimTranscript,
    fullTranscript: transcript + interimTranscript,
    error,
    startListening,
    stopListening,
    abort,
    clearTranscript
  };
}
