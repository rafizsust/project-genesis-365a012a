/**
 * Banner component to display pending (unsubmitted) speaking tests.
 * Shows on AIPractice and AIPracticeHistory pages.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Mic, Play, Trash2, Clock, AlertCircle } from 'lucide-react';
import type { PendingSpeakingTest } from '@/hooks/usePendingSpeakingTests';

interface PendingSpeakingTestBannerProps {
  pendingTests: PendingSpeakingTest[];
  onDiscard: (testId: string) => Promise<void>;
  variant?: 'compact' | 'full';
}

export function PendingSpeakingTestBanner({
  pendingTests,
  onDiscard,
  variant = 'full',
}: PendingSpeakingTestBannerProps) {
  const navigate = useNavigate();
  const [discardingId, setDiscardingId] = useState<string | null>(null);
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);

  if (pendingTests.length === 0) return null;

  // Show only the most recent pending test
  const mostRecent = pendingTests[0];
  
  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  };

  const formatTimeAgo = (timestamp: number) => {
    const now = Date.now();
    const diff = now - timestamp;
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    
    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (mins > 0) return `${mins}m ago`;
    return 'Just now';
  };

  const handleResume = () => {
    navigate(`/ai-practice/speaking/test/${mostRecent.testId}?restore=true`);
  };

  const handleDiscard = async () => {
    setDiscardingId(mostRecent.testId);
    try {
      await onDiscard(mostRecent.testId);
    } finally {
      setDiscardingId(null);
      setShowDiscardDialog(false);
    }
  };

  if (variant === 'compact') {
    return (
      <Alert className="border-primary/30 bg-primary/5">
        <Mic className="h-4 w-4 text-primary" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span className="text-sm">
            <strong>Unfinished speaking test</strong>
            {mostRecent.topic && `: ${mostRecent.topic}`}
            <span className="text-muted-foreground ml-2">
              ({mostRecent.segmentCount} recordings)
            </span>
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setShowDiscardDialog(true)}>
              <Trash2 className="h-3 w-3" />
            </Button>
            <Button size="sm" onClick={handleResume}>
              <Play className="h-3 w-3 mr-1" />
              Resume
            </Button>
          </div>
        </AlertDescription>
        
        <AlertDialog open={showDiscardDialog} onOpenChange={setShowDiscardDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Discard Recordings?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete {mostRecent.segmentCount} audio recordings. This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleDiscard} disabled={!!discardingId}>
                {discardingId ? 'Discarding...' : 'Discard'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Alert>
    );
  }

  return (
    <Alert className="border-primary/30 bg-gradient-to-r from-primary/10 to-primary/5">
      <AlertCircle className="h-4 w-4 text-primary" />
      <AlertDescription className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="font-medium flex items-center gap-2">
              <Mic className="h-4 w-4 text-primary" />
              Unfinished Speaking Test Found
            </p>
            {mostRecent.topic && (
              <p className="text-sm text-muted-foreground">
                Topic: <span className="font-medium text-foreground">{mostRecent.topic}</span>
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-1 text-xs">
            <Badge variant="secondary" className="flex items-center gap-1">
              <Mic className="h-3 w-3" />
              {mostRecent.segmentCount} recordings
            </Badge>
            <Badge variant="outline" className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatDuration(mostRecent.totalDuration)}
            </Badge>
            <Badge variant="outline" className="text-muted-foreground">
              {formatTimeAgo(mostRecent.savedAt)}
            </Badge>
          </div>
        </div>
        
        <div className="flex items-center gap-2 pt-1">
          <span className="text-sm text-muted-foreground">Parts recorded:</span>
          {([1, 2, 3] as const).map(part => (
            <Badge
              key={part}
              variant={mostRecent.recordedParts.includes(part) ? 'default' : 'outline'}
              className={mostRecent.recordedParts.includes(part) 
                ? 'bg-success/20 text-success border-success/30' 
                : 'opacity-50'}
            >
              Part {part}
            </Badge>
          ))}
        </div>
        
        <div className="flex gap-2 pt-2">
          <Button 
            variant="outline" 
            size="sm" 
            onClick={() => setShowDiscardDialog(true)}
            disabled={!!discardingId}
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Discard
          </Button>
          <Button size="sm" onClick={handleResume}>
            <Play className="h-4 w-4 mr-2" />
            Resume Test
          </Button>
        </div>
      </AlertDescription>
      
      <AlertDialog open={showDiscardDialog} onOpenChange={setShowDiscardDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard Recordings?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete {mostRecent.segmentCount} audio recordings 
              ({formatDuration(mostRecent.totalDuration)} of audio). This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDiscard} disabled={!!discardingId}>
              {discardingId ? 'Discarding...' : 'Discard Recordings'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Alert>
  );
}
