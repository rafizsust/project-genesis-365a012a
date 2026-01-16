/**
 * Instant Speech Feedback Component
 * DEPRECATED: This component is no longer used since we removed confidence tracking.
 * Kept for potential future use.
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { SpeechAnalysisResult } from '@/hooks/useAdvancedSpeechAnalysis';
import { Mic, Sparkles } from 'lucide-react';

interface Props {
  analysis: SpeechAnalysisResult;
  showDisclaimer?: boolean;
  compact?: boolean;
}

export function InstantSpeechFeedback({ analysis, compact = false }: Props) {
  const { rawTranscript, durationMs } = analysis;

  if (compact) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Mic className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium">Speech Captured</span>
          </div>
          <Badge variant="secondary">{Math.round(durationMs / 1000)}s</Badge>
        </div>
        <p className="text-sm text-muted-foreground line-clamp-2">{rawTranscript || 'No speech detected'}</p>
      </div>
    );
  }

  return (
    <Card className="border-primary/20">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Sparkles className="w-5 h-5 text-primary" />
            Speech Captured
          </CardTitle>
          <Badge variant="secondary">{Math.round(durationMs / 1000)}s</Badge>
        </div>
      </CardHeader>
      
      <CardContent>
        <div className="p-4 rounded-lg bg-muted/50 text-sm leading-relaxed min-h-[80px]">
          {rawTranscript || <span className="text-muted-foreground italic">No speech detected</span>}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Mini version for inline display during recording
 */
export function InstantSpeechMini({ 
  transcript, 
}: { 
  transcript: string; 
}) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <Badge variant="outline" className="gap-1">
        <Mic className="w-3 h-3" />
        Listening
      </Badge>
      <span className="text-muted-foreground truncate max-w-[200px]">{transcript}</span>
    </div>
  );
}
