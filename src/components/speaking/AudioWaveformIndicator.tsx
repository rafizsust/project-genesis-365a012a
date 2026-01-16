import { useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

interface AudioWaveformIndicatorProps {
  stream: MediaStream | null;
  isActive: boolean;
  className?: string;
  barCount?: number;
}

/**
 * Real-time audio waveform visualization component
 * Shows live audio input as a waveform bar chart
 */
export function AudioWaveformIndicator({ 
  stream, 
  isActive, 
  className,
  barCount = 32
}: AudioWaveformIndicatorProps) {
  const [waveformData, setWaveformData] = useState<number[]>(new Array(barCount).fill(0.1));
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyzerRef = useRef<AnalyserNode | null>(null);
  const animationRef = useRef<number | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  useEffect(() => {
    if (!stream || !isActive) {
      setWaveformData(new Array(barCount).fill(0.1));
      return;
    }

    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const analyzer = audioContext.createAnalyser();
      // Higher FFT size for more detailed waveform
      analyzer.fftSize = 256;
      analyzer.smoothingTimeConstant = 0.6;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyzer);

      audioContextRef.current = audioContext;
      analyzerRef.current = analyzer;
      sourceRef.current = source;

      const bufferLength = analyzer.frequencyBinCount;

      const dataArray = new Uint8Array(bufferLength);

      const updateWaveform = () => {
        if (!analyzerRef.current) return;

        // Get frequency data for waveform visualization
        analyzerRef.current.getByteFrequencyData(dataArray);
        
        // Sample the frequency data to match our bar count
        const sampledData: number[] = [];
        const step = Math.floor(bufferLength / barCount);
        
        for (let i = 0; i < barCount; i++) {
          const startIdx = i * step;
          const endIdx = Math.min(startIdx + step, bufferLength);
          
          // Average the values in this range
          let sum = 0;
          for (let j = startIdx; j < endIdx; j++) {
            sum += dataArray[j];
          }
          const avg = sum / (endIdx - startIdx);
          // Normalize to 0-1 range with minimum height
          const normalized = Math.max(0.1, Math.min(1, avg / 200));
          sampledData.push(normalized);
        }
        
        setWaveformData(sampledData);
        animationRef.current = requestAnimationFrame(updateWaveform);
      };

      updateWaveform();
    } catch (err) {
      console.warn('AudioWaveformIndicator: Failed to create audio context:', err);
    }

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close();
      }
    };
  }, [stream, isActive, barCount]);

  if (!isActive) return null;

  return (
    <div className={cn("flex items-center justify-center gap-[2px] h-12", className)}>
      {waveformData.map((value, index) => (
        <div
          key={index}
          className="w-1 bg-destructive rounded-full transition-all duration-75"
          style={{
            height: `${Math.max(4, value * 48)}px`,
            opacity: 0.6 + value * 0.4,
          }}
        />
      ))}
    </div>
  );
}
