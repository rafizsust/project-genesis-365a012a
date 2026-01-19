/**
 * Hook to check IndexedDB for pending (unsubmitted) speaking tests.
 * Used to show restore banners on AIPractice and AIPracticeHistory pages.
 */

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from './useAuth';
import { supabase } from '@/integrations/supabase/client';
import {
  getTestsWithPersistedAudio,
  loadAudioSegments,
  deleteAudioSegments,
} from './useSpeakingAudioPersistence';

export interface PendingSpeakingTest {
  testId: string;
  topic?: string;
  segmentCount: number;
  recordedParts: number[];
  totalDuration: number;
  savedAt: number;
}

export function usePendingSpeakingTests() {
  const { user } = useAuth();
  const [pendingTests, setPendingTests] = useState<PendingSpeakingTest[]>([]);
  const [loading, setLoading] = useState(true);

  const loadPendingTests = useCallback(async () => {
    if (!user) {
      setPendingTests([]);
      setLoading(false);
      return;
    }

    try {
      // Get all test IDs with persisted audio in IndexedDB
      const testIds = await getTestsWithPersistedAudio();
      
      if (testIds.length === 0) {
        setPendingTests([]);
        setLoading(false);
        return;
      }

      // Check which tests already have completed results
      const { data: completedResults } = await supabase
        .from('ai_practice_results')
        .select('test_id')
        .eq('user_id', user.id)
        .eq('module', 'speaking')
        .in('test_id', testIds);

      const completedTestIds = new Set((completedResults || []).map(r => r.test_id));

      // Filter out tests that already have results
      const pendingTestIds = testIds.filter(id => !completedTestIds.has(id));

      if (pendingTestIds.length === 0) {
        // Clean up orphaned audio for completed tests
        for (const id of testIds) {
          if (completedTestIds.has(id)) {
            await deleteAudioSegments(id);
          }
        }
        setPendingTests([]);
        setLoading(false);
        return;
      }

      // Get test metadata from ai_practice_tests
      const { data: testMeta } = await supabase
        .from('ai_practice_tests')
        .select('id, topic')
        .eq('user_id', user.id)
        .in('id', pendingTestIds);

      const testTopics = new Map<string, string>();
      (testMeta || []).forEach(t => testTopics.set(t.id, t.topic));

      // Build pending test info
      const pending: PendingSpeakingTest[] = [];
      
      for (const testId of pendingTestIds) {
        const segments = await loadAudioSegments(testId);
        if (segments.length === 0) continue;

        const recordedParts = [...new Set(segments.map(s => s.partNumber))].sort();
        const totalDuration = segments.reduce((acc, s) => acc + s.duration, 0);
        const savedAt = Math.max(...segments.map(s => s.savedAt));

        pending.push({
          testId,
          topic: testTopics.get(testId),
          segmentCount: segments.length,
          recordedParts,
          totalDuration,
          savedAt,
        });
      }

      // Sort by most recent first
      pending.sort((a, b) => b.savedAt - a.savedAt);
      
      setPendingTests(pending);
    } catch (err) {
      console.error('[usePendingSpeakingTests] Error loading pending tests:', err);
      setPendingTests([]);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadPendingTests();
  }, [loadPendingTests]);

  const discardTest = useCallback(async (testId: string) => {
    await deleteAudioSegments(testId);
    setPendingTests(prev => prev.filter(t => t.testId !== testId));
  }, []);

  const refresh = useCallback(() => {
    setLoading(true);
    loadPendingTests();
  }, [loadPendingTests]);

  return {
    pendingTests,
    loading,
    discardTest,
    refresh,
    hasPendingTests: pendingTests.length > 0,
  };
}
