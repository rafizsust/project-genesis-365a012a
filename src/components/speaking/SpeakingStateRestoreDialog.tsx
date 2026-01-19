import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Play, Send, RotateCcw, Mic, Clock, CheckCircle2 } from 'lucide-react';
import type { PersistedAudioSegment } from '@/hooks/useSpeakingAudioPersistence';

interface SpeakingStateRestoreDialogProps {
  open: boolean;
  segments: PersistedAudioSegment[];
  testTopic?: string;
  onResume: (resumePoint: { part: 1 | 2 | 3; questionIndex: number }) => void;
  onSubmit: () => void;
  onRestart: () => void;
}

export function SpeakingStateRestoreDialog({
  open,
  segments,
  testTopic,
  onResume,
  onSubmit,
  onRestart,
}: SpeakingStateRestoreDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Analyze segments to determine progress
  const recordedParts = new Set(segments.map(s => s.partNumber));
  const questionsByPart = new Map<number, number[]>();
  
  segments.forEach(seg => {
    const existing = questionsByPart.get(seg.partNumber) || [];
    if (!existing.includes(seg.questionNumber)) {
      existing.push(seg.questionNumber);
    }
    questionsByPart.set(seg.partNumber, existing.sort((a, b) => a - b));
  });

  const totalRecordings = segments.length;
  
  // Find where to resume (last recorded question + 1)
  const getResumePoint = (): { part: 1 | 2 | 3; questionIndex: number } => {
    // Find highest part with recordings
    const parts = [...recordedParts].sort((a, b) => b - a);
    if (parts.length === 0) return { part: 1, questionIndex: 0 };
    
    const lastPart = parts[0] as 1 | 2 | 3;
    const questions = questionsByPart.get(lastPart) || [];
    const lastQuestionNum = questions.length > 0 ? Math.max(...questions) : 0;
    
    // Resume at the next question
    return { part: lastPart, questionIndex: lastQuestionNum };
  };

  const resumePoint = getResumePoint();
  
  // Calculate approximate time saved
  const totalDuration = segments.reduce((acc, s) => acc + s.duration, 0);
  const minutesSaved = Math.floor(totalDuration / 60);
  const secondsSaved = Math.floor(totalDuration % 60);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    await onSubmit();
  };

  const handleResume = () => {
    onResume(resumePoint);
  };

  return (
    <AlertDialog open={open}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Mic className="h-5 w-5 text-primary" />
            Previous Session Found
          </AlertDialogTitle>
          <AlertDialogDescription className="space-y-4">
            <p>
              We found your previous speaking test recordings. Would you like to continue where you left off?
            </p>
            
            {testTopic && (
              <div className="text-sm">
                <span className="text-muted-foreground">Topic: </span>
                <span className="font-medium text-foreground">{testTopic}</span>
              </div>
            )}
            
            {/* Progress summary */}
            <div className="bg-muted/50 rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-success" />
                  Recordings saved
                </span>
                <span className="font-medium">{totalRecordings} questions</span>
              </div>
              
              {totalDuration > 0 && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground flex items-center gap-2">
                    <Clock className="w-4 h-4" />
                    Recording time
                  </span>
                  <span className="font-mono font-medium">
                    {minutesSaved > 0 ? `${minutesSaved}m ` : ''}{secondsSaved}s
                  </span>
                </div>
              )}
              
              {/* Parts recorded */}
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Parts:</span>
                <div className="flex gap-1">
                  {([1, 2, 3] as const).map(part => (
                    <Badge
                      key={part}
                      variant={recordedParts.has(part) ? "default" : "outline"}
                      className={recordedParts.has(part) ? "bg-success/20 text-success border-success/30" : "opacity-50"}
                    >
                      Part {part}
                      {recordedParts.has(part) && (
                        <span className="ml-1 text-xs">
                          ({questionsByPart.get(part)?.length || 0})
                        </span>
                      )}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>

            <p className="text-sm text-muted-foreground">
              You can resume from <strong>Part {resumePoint.part}, Question {resumePoint.questionIndex + 1}</strong>, 
              submit your recordings now, or start fresh.
            </p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
          <Button 
            variant="outline" 
            onClick={onRestart}
            className="w-full sm:w-auto gap-2"
          >
            <RotateCcw className="h-4 w-4" />
            Start Fresh
          </Button>
          <Button 
            variant="secondary"
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="w-full sm:w-auto gap-2"
          >
            <Send className="h-4 w-4" />
            {isSubmitting ? 'Submitting...' : 'Submit Now'}
          </Button>
          <Button 
            onClick={handleResume}
            className="w-full sm:w-auto gap-2"
          >
            <Play className="h-4 w-4" />
            Continue
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
