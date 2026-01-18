import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { Loader2, X, Timer } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEffect, useState } from 'react';

export type EvaluationStage = 
  | 'preparing'
  | 'converting'
  | 'uploading'
  | 'queuing'
  | 'pending'
  | 'pending_upload'
  | 'pending_text_eval'
  | 'transcribing'
  | 'evaluating'
  | 'evaluating_text'
  | 'evaluating_part_1'
  | 'evaluating_part_2'
  | 'evaluating_part_3'
  | 'generating_feedback'
  | 'generating'
  | 'finalizing'
  | 'saving'
  | 'completed'
  | 'cancelled'
  | 'failed';

interface InlineProgressBannerProps {
  stage: EvaluationStage | string | null;
  currentPart?: number;
  totalParts?: number;
  progress?: number;
  startTime?: string;
  mode?: 'basic' | 'accuracy';
  onCancel?: () => void;
  isCancelling?: boolean;
  className?: string;
}

// Format milliseconds to human readable time
function formatElapsedTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

// Live elapsed time component
function LiveElapsedTime({ startTime }: { startTime: string }) {
  const [elapsed, setElapsed] = useState('');
  
  useEffect(() => {
    const start = new Date(startTime).getTime();
    
    const update = () => {
      const now = Date.now();
      const durationMs = now - start;
      setElapsed(formatElapsedTime(durationMs));
    };
    
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [startTime]);
  
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <Timer className="w-3 h-3" />
      {elapsed}
    </span>
  );
}

// Get stage label for display
function getStageLabel(stage: string | null | undefined, currentPart?: number, totalParts?: number): string {
  const parts = totalParts && totalParts > 0 ? totalParts : 3;
  const partLabel = (p: number) => `Part ${p}/${parts}`;

  if (!stage) return 'Processing...';

  switch (stage) {
    case 'preparing':
      return 'Preparing...';
    case 'converting':
      return 'Converting audio...';
    case 'uploading':
      return 'Uploading audio...';
    case 'pending_upload':
    case 'pending_text_eval':
    case 'pending':
    case 'queuing':
      return 'Queued';
    case 'transcribing':
      return 'Transcribing';
    case 'evaluating_text':
    case 'evaluating':
    case 'evaluating_part_1':
      return `Evaluating ${partLabel(currentPart && currentPart > 0 ? currentPart : 1)}`;
    case 'evaluating_part_2':
      return `Evaluating ${partLabel(2)}`;
    case 'evaluating_part_3':
      return `Evaluating ${partLabel(3)}`;
    case 'generating_feedback':
    case 'generating':
      return 'Generating feedback';
    case 'finalizing':
    case 'saving':
      return 'Saving results';
    case 'completed':
      return 'Complete';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return 'Failed';
    default:
      return 'Processing...';
  }
}

// Calculate approximate progress from stage
function getProgressFromStage(stage: string | null | undefined, progress?: number): number {
  if (typeof progress === 'number' && progress > 0) return progress;
  
  if (!stage) return 5;
  
  switch (stage) {
    case 'preparing': return 5;
    case 'converting': return 10;
    case 'uploading': return 20;
    case 'pending_upload':
    case 'pending_text_eval':
    case 'pending':
    case 'queuing': return 25;
    case 'transcribing': return 35;
    case 'evaluating':
    case 'evaluating_text':
    case 'evaluating_part_1': return 45;
    case 'evaluating_part_2': return 60;
    case 'evaluating_part_3': return 75;
    case 'generating_feedback':
    case 'generating': return 85;
    case 'finalizing':
    case 'saving': return 95;
    case 'completed': return 100;
    default: return 30;
  }
}

export function InlineProgressBanner({
  stage,
  currentPart,
  totalParts,
  progress,
  startTime,
  mode,
  onCancel,
  isCancelling,
  className,
}: InlineProgressBannerProps) {
  const displayProgress = getProgressFromStage(stage, progress);
  const stageLabel = getStageLabel(stage, currentPart, totalParts);
  
  return (
    <div className={cn(
      "flex items-center gap-3 p-2 rounded-lg bg-primary/5 border border-primary/20",
      className
    )}>
      {/* Spinner */}
      <Loader2 className="w-4 h-4 animate-spin text-primary shrink-0" />
      
      {/* Stage + Progress */}
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-primary truncate">
            {stageLabel}
            {mode && (
              <span className="ml-1.5 text-muted-foreground font-normal">
                ({mode === 'accuracy' ? 'Accuracy' : 'Basic'})
              </span>
            )}
          </span>
          {startTime && <LiveElapsedTime startTime={startTime} />}
        </div>
        <Progress value={displayProgress} className="h-1.5" />
      </div>
      
      {/* Cancel button */}
      {onCancel && (
        <Button
          variant="ghost"
          size="icon"
          onClick={(e) => {
            e.stopPropagation();
            onCancel();
          }}
          disabled={isCancelling}
          className="h-6 w-6 text-muted-foreground hover:text-destructive shrink-0"
          title="Cancel evaluation"
        >
          {isCancelling ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <X className="w-3 h-3" />
          )}
        </Button>
      )}
    </div>
  );
}
