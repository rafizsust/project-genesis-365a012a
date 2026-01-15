/**
 * Pause & Gap Tracking (All Browsers)
 * Critical for fluency scoring
 */

export interface PauseEvent {
  startTime: number;
  endTime: number;
  duration: number;
  type: 'hesitation' | 'pause' | 'breakdown';
}

export interface PauseMetrics {
  totalPauses: number;
  hesitations: number;      // ≥500ms
  noticeablePauses: number; // ≥1000ms
  fluencyBreakdowns: number; // ≥2000ms
  totalPauseDuration: number;
  averagePauseDuration: number;
  longestPause: number;
  pauseEvents: PauseEvent[];
}

export class PauseTracker {
  private lastEventTime: number = 0;
  private pauseEvents: PauseEvent[] = [];
  private sessionStartTime: number = 0;
  private isTracking: boolean = false;
  
  // Thresholds (in milliseconds)
  private readonly HESITATION_THRESHOLD = 500;
  private readonly NOTICEABLE_PAUSE_THRESHOLD = 1000;
  private readonly BREAKDOWN_THRESHOLD = 2000;
  
  start(): void {
    this.sessionStartTime = Date.now();
    this.lastEventTime = this.sessionStartTime;
    this.pauseEvents = [];
    this.isTracking = true;
  }
  
  stop(): void {
    this.isTracking = false;
  }
  
  reset(): void {
    this.lastEventTime = 0;
    this.pauseEvents = [];
    this.sessionStartTime = 0;
    this.isTracking = false;
  }
  
  /**
   * Record a speech event and calculate gap from last event
   */
  recordSpeechEvent(): void {
    if (!this.isTracking) return;
    
    const currentTime = Date.now();
    const gap = currentTime - this.lastEventTime;
    
    // Only record significant pauses
    if (gap >= this.HESITATION_THRESHOLD) {
      const pauseEvent: PauseEvent = {
        startTime: this.lastEventTime,
        endTime: currentTime,
        duration: gap,
        type: this.classifyPause(gap)
      };
      
      this.pauseEvents.push(pauseEvent);
    }
    
    this.lastEventTime = currentTime;
  }
  
  private classifyPause(duration: number): PauseEvent['type'] {
    if (duration >= this.BREAKDOWN_THRESHOLD) return 'breakdown';
    if (duration >= this.NOTICEABLE_PAUSE_THRESHOLD) return 'pause';
    return 'hesitation';
  }
  
  /**
   * Get comprehensive pause metrics for fluency evaluation
   */
  getMetrics(): PauseMetrics {
    const hesitations = this.pauseEvents.filter(p => p.type === 'hesitation').length;
    const noticeablePauses = this.pauseEvents.filter(p => p.type === 'pause').length;
    const fluencyBreakdowns = this.pauseEvents.filter(p => p.type === 'breakdown').length;
    
    const totalPauseDuration = this.pauseEvents.reduce((sum, p) => sum + p.duration, 0);
    const longestPause = this.pauseEvents.length > 0 
      ? Math.max(...this.pauseEvents.map(p => p.duration))
      : 0;
    
    return {
      totalPauses: this.pauseEvents.length,
      hesitations,
      noticeablePauses,
      fluencyBreakdowns,
      totalPauseDuration,
      averagePauseDuration: this.pauseEvents.length > 0 
        ? totalPauseDuration / this.pauseEvents.length 
        : 0,
      longestPause,
      pauseEvents: [...this.pauseEvents]
    };
  }
  
  /**
   * Get current gap since last speech event
   */
  getCurrentGap(): number {
    if (!this.isTracking || this.lastEventTime === 0) return 0;
    return Date.now() - this.lastEventTime;
  }
  
  /**
   * Check if currently in a long silence
   */
  isInSilence(thresholdMs: number = 2000): boolean {
    return this.getCurrentGap() >= thresholdMs;
  }
}
