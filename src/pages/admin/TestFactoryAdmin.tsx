import { useState, useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAdminAccess } from "@/hooks/useAdminAccess";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  Factory,
  Play,
  RefreshCw,
  CheckCircle,
  XCircle,
  Clock,
  Loader2,
  Eye,
  Upload,
  ArrowLeft,
  Volume2,
  BookOpen,
  Mic,
  PenLine,
  Trash2,
  RotateCcw,
  Filter,
  X,
  Calendar,
} from "lucide-react";
import {
  READING_TOPICS,
  LISTENING_TOPICS,
  WRITING_TASK1_TOPICS,
  WRITING_TASK2_TOPICS,
  SPEAKING_TOPICS_PART1,
  SPEAKING_TOPICS_PART2,
  SPEAKING_TOPICS_PART3,
  SPEAKING_TOPICS_FULL,
} from "@/lib/ieltsTopics";
import GeneratedTestPreview from "@/components/admin/GeneratedTestPreview";
import { compressAudio } from "@/utils/audioCompressor";
import { uploadToR2 } from "@/lib/r2Upload";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface GenerationJob {
  id: string;
  module: string;
  topic: string;
  difficulty: string;
  quantity: number;
  question_type: string;
  monologue: boolean;
  status: string;
  success_count: number;
  failure_count: number;
  error_log: Array<{ index: number; error: string }>;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface GeneratedTest {
  id: string;
  status: string;
  voice_id: string;
  accent: string;
  question_type: string;
  is_published: boolean;
  created_at: string;
  content_payload: Record<string, unknown>;
  module: string;
}

const MODULES = [
  { value: "reading", label: "Reading", icon: BookOpen },
  { value: "listening", label: "Listening", icon: Volume2 },
  { value: "writing", label: "Writing", icon: PenLine },
  { value: "speaking", label: "Speaking", icon: Mic },
];

const DIFFICULTIES = [
  { value: "easy", label: "Easy (Band 5.5-6.5)" },
  { value: "medium", label: "Medium (Band 7-8)" },
  { value: "hard", label: "Hard (Band 8.5-9)" },
];

// Task 1 visual types for dropdown (synced with AIPractice.tsx)
const WRITING_TASK1_VISUAL_TYPES = [
  { value: "RANDOM", label: "Random" },
  { value: "BAR_CHART", label: "Bar Chart" },
  { value: "LINE_GRAPH", label: "Line Graph" },
  { value: "PIE_CHART", label: "Pie Chart" },
  { value: "TABLE", label: "Table" },
  { value: "MIXED_CHARTS", label: "Mixed Charts" },
  { value: "PROCESS_DIAGRAM", label: "Process Diagram" },
  { value: "MAP", label: "Map Comparison" },
  { value: "COMPARISON_DIAGRAM", label: "Comparison Diagram" },
];

// Task 2 essay types for dropdown (synced with AIPractice.tsx)
const WRITING_TASK2_ESSAY_TYPES = [
  { value: "RANDOM", label: "Random" },
  { value: "OPINION", label: "Opinion/Agree-Disagree" },
  { value: "DISCUSSION", label: "Discussion" },
  { value: "PROBLEM_SOLUTION", label: "Problem & Solution" },
  { value: "ADVANTAGES_DISADVANTAGES", label: "Advantages & Disadvantages" },
  { value: "TWO_PART_QUESTION", label: "Two-Part Question" },
];

// Question types by module - matching test taker options
const QUESTION_TYPES = {
  reading: [
    { value: "mixed", label: "Mixed (All Types)" },
    { value: "TRUE_FALSE_NOT_GIVEN", label: "True/False/Not Given" },
    { value: "YES_NO_NOT_GIVEN", label: "Yes/No/Not Given" },
    { value: "MULTIPLE_CHOICE_SINGLE", label: "Multiple Choice (Single)" },
    { value: "MULTIPLE_CHOICE_MULTIPLE", label: "Multiple Choice (Multiple)" },
    { value: "MATCHING_HEADINGS", label: "Matching Headings" },
    { value: "MATCHING_FEATURES", label: "Matching Features" },
    { value: "MATCHING_INFORMATION", label: "Matching Information" },
    { value: "MATCHING_SENTENCE_ENDINGS", label: "Matching Sentence Endings" },
    { value: "SENTENCE_COMPLETION", label: "Sentence Completion" },
    { value: "SUMMARY_COMPLETION", label: "Summary Completion" },
    { value: "NOTE_COMPLETION", label: "Note Completion" },
    { value: "TABLE_COMPLETION", label: "Table Completion" },
    { value: "FLOWCHART_COMPLETION", label: "Flowchart Completion" },
    { value: "SHORT_ANSWER", label: "Short Answer" },
  ],
  listening: [
    { value: "mixed", label: "Mixed (All Types)" },
    { value: "FILL_IN_BLANK", label: "Fill in the Blank" },
    { value: "MULTIPLE_CHOICE_SINGLE", label: "Multiple Choice (Single)" },
    { value: "MULTIPLE_CHOICE_MULTIPLE", label: "Multiple Choice (Multiple)" },
    { value: "MATCHING_CORRECT_LETTER", label: "Matching" },
    { value: "TABLE_COMPLETION", label: "Table Completion" },
    { value: "NOTE_COMPLETION", label: "Note Completion" },
    { value: "FLOWCHART_COMPLETION", label: "Flowchart Completion" },
    { value: "MAP_LABELING", label: "Map/Plan Labeling" },
    { value: "DRAG_AND_DROP_OPTIONS", label: "Drag and Drop" },
  ],
  writing: [
    { value: "FULL_TEST", label: "Full Test (Task 1 + Task 2)" },
    { value: "TASK_1", label: "Task 1 (Data Description)" },
    { value: "TASK_2", label: "Task 2 (Essay)" },
  ],
  speaking: [
    { value: "FULL_TEST", label: "Full Test (Part 1, 2, 3)" },
    { value: "PART_1", label: "Part 1 Only" },
    { value: "PART_2", label: "Part 2 Only" },
    { value: "PART_3", label: "Part 3 Only" },
  ],
};

// Get topics by module and question type (synced with AIPractice.tsx)
function getTopicsForModule(module: string, questionType?: string): readonly string[] {
  switch (module) {
    case "reading":
      return READING_TOPICS;
    case "listening":
      return LISTENING_TOPICS;
    case "writing":
      return questionType === "TASK_1" ? WRITING_TASK1_TOPICS : WRITING_TASK2_TOPICS;
    case "speaking":
      switch (questionType) {
        case "PART_1": return SPEAKING_TOPICS_PART1;
        case "PART_2": return SPEAKING_TOPICS_PART2;
        case "PART_3": return SPEAKING_TOPICS_PART3;
        default: return SPEAKING_TOPICS_FULL;
      }
    default:
      return [];
  }
}

export default function TestFactoryAdmin() {
  const navigate = useNavigate();
  const { isAdmin, loading: adminLoading } = useAdminAccess();

  // Form state
  const [module, setModule] = useState<string>("reading");
  const [topic, setTopic] = useState<string>("");
  const [questionType, setQuestionType] = useState<string>("mixed");
  const [difficulty, setDifficulty] = useState<string>("medium");
  const [quantity, setQuantity] = useState<number>(5);
  const [monologue, setMonologue] = useState<boolean>(false);
  // Writing-specific task type selections (synced with AIPractice.tsx)
  const [writingTask1VisualType, setWritingTask1VisualType] = useState<string>("RANDOM");
  const [writingTask2EssayType, setWritingTask2EssayType] = useState<string>("RANDOM");
  const [isGenerating, setIsGenerating] = useState(false);
  // Jobs state
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [selectedJob, setSelectedJob] = useState<GenerationJob | null>(null);
  const [jobTests, setJobTests] = useState<GeneratedTest[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(true);
  
  // Filter state
  const [filterModule, setFilterModule] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterDateFrom, setFilterDateFrom] = useState<string>("");
  const [filterDateTo, setFilterDateTo] = useState<string>("");
  
  // Preview & Delete state
  const [previewTest, setPreviewTest] = useState<GeneratedTest | null>(null);
  const [deleteTestId, setDeleteTestId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [retryingTestId, setRetryingTestId] = useState<string | null>(null);
  const [cancelingJobId, setCancelingJobId] = useState<string | null>(null);

  // Filtered jobs
  const filteredJobs = useMemo(() => {
    return jobs.filter(job => {
      if (filterModule !== "all" && job.module !== filterModule) return false;
      if (filterStatus !== "all" && job.status !== filterStatus) return false;
      if (filterDateFrom) {
        const jobDate = new Date(job.created_at).toISOString().split('T')[0];
        if (jobDate < filterDateFrom) return false;
      }
      if (filterDateTo) {
        const jobDate = new Date(job.created_at).toISOString().split('T')[0];
        if (jobDate > filterDateTo) return false;
      }
      return true;
    });
  }, [jobs, filterModule, filterStatus, filterDateFrom, filterDateTo]);

  const hasActiveFilters = filterModule !== "all" || filterStatus !== "all" || filterDateFrom || filterDateTo;

  const clearFilters = () => {
    setFilterModule("all");
    setFilterStatus("all");
    setFilterDateFrom("");
    setFilterDateTo("");
  };

  // Reset topic and question type when module changes
  useEffect(() => {
    setTopic("");
    setQuestionType("mixed");
    setMonologue(false);
  }, [module]);

  // Reset topic when question type changes for modules with type-specific topics (speaking, writing)
  useEffect(() => {
    if (module === "speaking" || module === "writing") {
      setTopic("");
    }
  }, [questionType, module]);

  // Fetch jobs on mount (polling to guarantee near real-time updates)
  useEffect(() => {
    if (!isAdmin) return;

    fetchJobs();
    const intervalId = window.setInterval(fetchJobs, 5000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isAdmin]);

  // Fetch job details when selected (polling)
  useEffect(() => {
    if (!selectedJob) return;

    fetchJobDetails(selectedJob.id);
    const intervalId = window.setInterval(() => fetchJobDetails(selectedJob.id), 5000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [selectedJob?.id]);

  // Auto-compress speaking WAV -> MP3 in the browser (no button, avoids edge CPU limits)
  const autoCompressedTestIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!selectedJob) return;
    if (selectedJob.module !== "speaking") return;
    if (!jobTests.length) return;

    const candidates = jobTests.filter((t) => {
      if (autoCompressedTestIdsRef.current.has(t.id)) return false;
      const payload = (t.content_payload || {}) as any;
      const audioUrls = payload.audioUrls as Record<string, string> | undefined;
      if (!audioUrls) return false;
      return Object.values(audioUrls).some((u) => typeof u === "string" && u.endsWith(".wav"));
    });

    if (candidates.length === 0) return;

    // Fire-and-forget, but keep it sequential to avoid pegging the browser
    (async () => {
      for (const test of candidates) {
        autoCompressedTestIdsRef.current.add(test.id);
        try {
          await autoCompressSpeakingTest(test);
        } catch (err) {
          console.error("Auto-compress failed:", err);
          // Allow retry on next polling cycle
          autoCompressedTestIdsRef.current.delete(test.id);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobTests, selectedJob?.id]);

  const fetchJobs = async () => {
    try {
      const { data, error } = await supabase.functions.invoke("get-job-status");
      if (error) throw error;

      if ((data as any)?.jobs) {
        const nextJobs = (data as any).jobs as GenerationJob[];
        setJobs(nextJobs);

        // ALSO auto-compress completed speaking jobs even if you never click into them.
        // This is the only "100%" way to avoid edge CPU timeouts while still ending up with MP3s.
        const completedSpeakingJobs = nextJobs
          .filter((j) => j.module === "speaking" && j.status === "completed")
          .slice(0, 3); // safety: only process newest few in background

        for (const job of completedSpeakingJobs) {
          // Fetch tests for the job (without switching UI selection)
          const { data: jobData, error: jobErr } = await supabase.functions.invoke("get-job-status", {
            body: { jobId: job.id },
          });
          if (jobErr) {
            console.warn("Failed fetching job tests for auto-compress:", jobErr);
            continue;
          }

          const tests = (jobData as any)?.tests as GeneratedTest[] | undefined;
          if (!tests?.length) continue;

          // Sequential to avoid pegging CPU/network
          for (const t of tests) {
            const payload = (t.content_payload || {}) as any;
            const audioUrls = payload.audioUrls as Record<string, string> | undefined;
            if (!audioUrls) continue;
            const hasWav = Object.values(audioUrls).some((u) => typeof u === "string" && u.endsWith(".wav"));
            if (!hasWav) continue;
            if (autoCompressedTestIdsRef.current.has(t.id)) continue;

            autoCompressedTestIdsRef.current.add(t.id);
            try {
              await autoCompressSpeakingTest(t);
            } catch (e) {
              console.error("Auto-compress (background) failed:", e);
              autoCompressedTestIdsRef.current.delete(t.id);
            }
          }
        }
      }
    } catch (error) {
      console.error("Failed to fetch jobs:", error);
    } finally {
      setLoadingJobs(false);
    }
  };

  const fetchJobDetails = async (jobId: string) => {
    try {
      const { data, error } = await supabase.functions.invoke("get-job-status", {
        body: { jobId },
      });
      if (error) throw error;

      if ((data as any)?.tests) {
        setJobTests((data as any).tests);
      }
    } catch (error) {
      console.error("Failed to fetch job details:", error);
    }
  };

  const autoCompressSpeakingTest = async (test: GeneratedTest) => {
    const payload = (test.content_payload || {}) as any;
    const audioUrls = payload.audioUrls as Record<string, string> | undefined;
    if (!audioUrls) return;

    // Only handle WAVs produced by bulk generation
    const wavEntries = Object.entries(audioUrls).filter(([, url]) => typeof url === "string" && url.endsWith(".wav"));
    if (wavEntries.length === 0) return;

    const newAudioUrls: Record<string, string> = { ...audioUrls };

    for (const [audioKey, wavUrl] of wavEntries) {
      // Convert public URL -> R2 key
      // Example: https://.../presets/speaking/<jobId>/<index>/<file>.wav
      const urlObj = new URL(wavUrl);
      const r2Key = urlObj.pathname.replace(/^\//, "");

      const { data: dl, error: dlError } = await supabase.functions.invoke("download-media", {
        body: { key: r2Key },
      });
      if (dlError) throw dlError;
      if (!(dl as any)?.success || !(dl as any)?.base64) {
        throw new Error((dl as any)?.error || "Download failed");
      }

      const bytes = Uint8Array.from(atob((dl as any).base64), (c) => c.charCodeAt(0));
      const wavFile = new File([bytes], `${audioKey}.wav`, { type: (dl as any)?.contentType || "audio/wav" });

      const mp3File = await compressAudio(wavFile);

      const mp3Key = r2Key.replace(/\.wav$/i, ".mp3");
      const mp3Folder = mp3Key.split("/").slice(0, -1).join("/");
      const mp3FileName = mp3Key.split("/").pop();

      const uploadRes = await uploadToR2({
        file: mp3File,
        folder: mp3Folder,
        fileName: mp3FileName,
      });
      if (!uploadRes.success || !uploadRes.url) {
        throw new Error(uploadRes.error || "MP3 upload failed");
      }

      // Delete WAV after MP3 is safely uploaded
      const { data: del, error: delErr } = await supabase.functions.invoke("delete-media", {
        body: { key: r2Key },
      });
      if (delErr) throw delErr;
      if (!(del as any)?.success) {
        throw new Error((del as any)?.error || "Failed to delete WAV");
      }

      newAudioUrls[audioKey] = uploadRes.url;
    }

    const newPayload = {
      ...payload,
      audioUrls: newAudioUrls,
      audioFormat: "mp3",
    };

    const { error: updateErr } = await supabase
      .from("generated_test_audio")
      .update({ content_payload: newPayload })
      .eq("id", test.id);

    if (updateErr) throw updateErr;
  };

  const startGeneration = async () => {
    // For writing, all task types have random topic selection (no validation needed)
    const isWriting = module === "writing";
    
    if (!isWriting && !topic) {
      toast.error("Please select a topic");
      return;
    }

    setIsGenerating(true);
    try {
      // For writing, randomly select topics based on task type
      let effectiveTopic = topic;
      let task1Topic = topic;
      let task2Topic = topic;
      
      if (isWriting) {
        // Randomly select topics from appropriate pools
        task1Topic = WRITING_TASK1_TOPICS[Math.floor(Math.random() * WRITING_TASK1_TOPICS.length)];
        task2Topic = WRITING_TASK2_TOPICS[Math.floor(Math.random() * WRITING_TASK2_TOPICS.length)];
        
        if (questionType === "FULL_TEST") {
          effectiveTopic = `${task1Topic} / ${task2Topic}`;
        } else if (questionType === "TASK_1") {
          effectiveTopic = task1Topic;
        } else {
          effectiveTopic = task2Topic;
        }
      }
      
      const payload: Record<string, unknown> = {
        module,
        topic: effectiveTopic,
        difficulty,
        quantity,
        questionType,
      };

      // Add monologue only for listening
      if (module === "listening") {
        payload.monologue = monologue;
      }

      // Add writing config for task type selections
      if (module === "writing") {
        const isFullTest = questionType === "FULL_TEST";
        payload.writingConfig = {
          taskType: questionType,
          task1VisualType: writingTask1VisualType,
          task2EssayType: writingTask2EssayType,
          task1Topic: isFullTest ? task1Topic : task1Topic,
          task2Topic: isFullTest ? task2Topic : task2Topic,
        };
      }

      const { data, error } = await supabase.functions.invoke("bulk-generate-tests", {
        body: payload,
      });

      if (error) throw error;

      if ((data as any)?.success) {
        toast.success((data as any).message);
        fetchJobs();
      } else {
        toast.error((data as any)?.error || "Failed to start generation");
      }
    } catch (error) {
      console.error("Generation error:", error);
      toast.error("Failed to start generation");
    } finally {
      setIsGenerating(false);
    }
  };

  const publishTests = async (testIds: string[], publish: boolean) => {
    try {
      const { data, error } = await supabase.functions.invoke("publish-generated-tests", {
        body: { testIds, publish },
      });
      if (error) throw error;

      if ((data as any)?.success) {
        toast.success((data as any).message);
        if (selectedJob) {
          fetchJobDetails(selectedJob.id);
        }
      } else {
        toast.error((data as any)?.error || "Failed to update tests");
      }
    } catch (error) {
      toast.error("Failed to update tests");
    }
  };


  const deleteTest = async (testId: string) => {
    setIsDeleting(true);
    try {
      const { error } = await supabase
        .from("generated_test_audio")
        .delete()
        .eq("id", testId);

      if (error) throw error;
      
      toast.success("Test deleted");
      setDeleteTestId(null);
      if (selectedJob) {
        fetchJobDetails(selectedJob.id);
      }
    } catch (error) {
      console.error("Delete error:", error);
      toast.error("Failed to delete test");
    } finally {
      setIsDeleting(false);
    }
  };

  const retryTest = async (test: GeneratedTest) => {
    if (!selectedJob) return;

    setRetryingTestId(test.id);
    try {
      const { data, error } = await supabase.functions.invoke("bulk-generate-tests", {
        body: {
          module: selectedJob.module,
          topic: selectedJob.topic,
          difficulty: selectedJob.difficulty,
          quantity: 1,
          questionType: test.question_type || selectedJob.question_type,
          monologue: selectedJob.monologue,
        },
      });

      if (error) throw error;

      if ((data as any)?.success) {
        toast.success("Retry started - new test will appear shortly");
        // Delete the failed test
        await supabase.from("generated_test_audio").delete().eq("id", test.id);

        setTimeout(() => fetchJobDetails(selectedJob.id), 2000);
      } else {
        toast.error((data as any)?.error || "Failed to retry");
      }
    } catch (error) {
      console.error("Retry error:", error);
      toast.error("Failed to retry test generation");
    } finally {
      setRetryingTestId(null);
    }
  };

  const cancelJob = async (jobId: string) => {
    setCancelingJobId(jobId);
    try {
      const { error } = await supabase
        .from("bulk_generation_jobs")
        .update({ status: "cancelled" })
        .eq("id", jobId);

      if (error) throw error;
      toast.success("Cancellation requested");
      fetchJobs();

      if (selectedJob?.id === jobId) {
        setSelectedJob((prev) => (prev ? { ...prev, status: "cancelled" } : prev));
      }
    } catch (error) {
      console.error("Cancel job error:", error);
      toast.error("Failed to cancel job");
    } finally {
      setCancelingJobId(null);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return (
          <Badge variant="secondary">
            <Clock className="h-3 w-3 mr-1" />Pending
          </Badge>
        );
      case "processing":
        return (
          <Badge variant="default" className="bg-blue-500">
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />Processing
          </Badge>
        );
      case "completed":
        return (
          <Badge variant="default" className="bg-green-500">
            <CheckCircle className="h-3 w-3 mr-1" />Completed
          </Badge>
        );
      case "failed":
        return (
          <Badge variant="destructive">
            <XCircle className="h-3 w-3 mr-1" />Failed
          </Badge>
        );
      case "cancelled":
        return <Badge variant="outline">Cancelled</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getModuleIcon = (mod: string) => {
    switch (mod) {
      case "reading": return <BookOpen className="h-4 w-4" />;
      case "listening": return <Volume2 className="h-4 w-4" />;
      case "writing": return <PenLine className="h-4 w-4" />;
      case "speaking": return <Mic className="h-4 w-4" />;
      default: return null;
    }
  };

  const formatDuration = (startedAt: string | null, completedAt: string | null) => {
    if (!startedAt || !completedAt) return null;
    const duration = new Date(completedAt).getTime() - new Date(startedAt).getTime();
    const minutes = Math.floor(duration / 60000);
    const seconds = Math.floor((duration % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
  };

  if (adminLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground">Admin access required</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const topics = getTopicsForModule(module, questionType);
  const questionTypes = QUESTION_TYPES[module as keyof typeof QUESTION_TYPES] || [];

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate("/admin")}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-3xl font-bold flex items-center gap-2">
                <Factory className="h-8 w-8" />
                AI Test Factory
              </h1>
              <p className="text-muted-foreground">Bulk generate AI practice tests for the test bank</p>
            </div>
          </div>
          <Button variant="outline" onClick={fetchJobs}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Generation Form */}
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle>New Generation Job</CardTitle>
              <CardDescription>Configure and start bulk test generation</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Module Selection */}
              <div className="space-y-2">
                <Label>Module</Label>
                <Select value={module} onValueChange={setModule}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MODULES.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        <div className="flex items-center gap-2">
                          <m.icon className="h-4 w-4" />
                          {m.label}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Question Type Selection - BEFORE topic for speaking since topic depends on question type */}
              <div className="space-y-2">
                <Label>Question Type</Label>
                <Select value={questionType} onValueChange={setQuestionType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {questionTypes.map((qt) => (
                      <SelectItem key={qt.value} value={qt.value}>
                        {qt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Topic Selection - hidden for writing (all types - topics are randomly selected) */}
              {module !== "writing" && (
                <div className="space-y-2">
                  <Label>Topic</Label>
                  <Select value={topic} onValueChange={setTopic}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a topic" />
                    </SelectTrigger>
                    <SelectContent>
                      {topics.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              
              {/* Info box for writing random topic selection (all task types) */}
              {module === "writing" && (
                <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 text-sm">
                  <p className="font-medium text-blue-600 dark:text-blue-400">Random Topic Selection</p>
                  <p className="text-muted-foreground text-xs mt-1">
                    Topics will be randomly selected for each generated test.
                  </p>
                </div>
              )}

              {/* Difficulty Selection */}
              <div className="space-y-2">
                <Label>Difficulty</Label>
                <Select value={difficulty} onValueChange={setDifficulty}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DIFFICULTIES.map((d) => (
                      <SelectItem key={d.value} value={d.value}>
                        {d.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Monologue Toggle (Listening - only for Fill in the Blank) */}
              {module === "listening" && questionType === "FILL_IN_BLANK" && (
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Monologue Mode</Label>
                    <p className="text-xs text-muted-foreground">
                      Single speaker (like IELTS Part 4)
                    </p>
                  </div>
                  <Switch
                    checked={monologue}
                    onCheckedChange={setMonologue}
                  />
                </div>
              )}

              {/* Writing Task Type Selections - only for Task 1 or Task 2 (not Full Test) */}
              {module === "writing" && questionType !== "FULL_TEST" && (
                <>
                  {questionType === "TASK_1" && (
                    <div className="space-y-2">
                      <Label>Visual Type</Label>
                      <Select value={writingTask1VisualType} onValueChange={setWritingTask1VisualType}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {WRITING_TASK1_VISUAL_TYPES.map((vt) => (
                            <SelectItem key={vt.value} value={vt.value}>
                              {vt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {questionType === "TASK_2" && (
                    <div className="space-y-2">
                      <Label>Essay Type</Label>
                      <Select value={writingTask2EssayType} onValueChange={setWritingTask2EssayType}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {WRITING_TASK2_ESSAY_TYPES.map((et) => (
                            <SelectItem key={et.value} value={et.value}>
                              {et.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </>
              )}

              {/* Quantity Slider */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <Label>Quantity</Label>
                  <span className="text-2xl font-bold">{quantity}</span>
                </div>
                <Slider
                  value={[quantity]}
                  onValueChange={(v) => setQuantity(v[0])}
                  min={1}
                  max={50}
                  step={1}
                />
                <p className="text-xs text-muted-foreground">
                  Generate 1-50 tests at once
                </p>
              </div>

              {/* Fixed Parameters Info */}
              <div className="bg-muted/50 rounded-lg p-3 space-y-1 text-sm">
                <p className="font-medium">Fixed Parameters:</p>
                {module === "reading" && (
                  <p className="text-muted-foreground">• 7 questions, 4 paragraphs</p>
                )}
                {module === "listening" && (
                  <p className="text-muted-foreground">• 7 questions, ~4 min audio</p>
                )}
                {module === "writing" && (
                  <p className="text-muted-foreground">• Standard IELTS task format</p>
                )}
                {module === "speaking" && (
                  <p className="text-muted-foreground">• Audio for all questions</p>
                )}
              </div>

              {/* Start Button */}
              <Button
                className="w-full"
                size="lg"
                onClick={startGeneration}
                disabled={isGenerating || (module !== "writing" && !topic)}
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                    Starting...
                  </>
                ) : (
                  <>
                    <Play className="h-5 w-5 mr-2" />
                    Start Generation ({quantity} tests)
                  </>
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Jobs List */}
          <Card className="lg:col-span-2">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Generation Jobs</CardTitle>
                  <CardDescription>Monitor your bulk generation jobs (AI Tests only)</CardDescription>
                </div>
                {hasActiveFilters && (
                  <Button variant="ghost" size="sm" onClick={clearFilters}>
                    <X className="h-4 w-4 mr-1" />
                    Clear Filters
                  </Button>
                )}
              </div>
              
              {/* Filters */}
              <div className="flex flex-wrap gap-3 pt-4 border-t">
                <div className="flex items-center gap-2">
                  <Filter className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Filters:</span>
                </div>
                
                <Select value={filterModule} onValueChange={setFilterModule}>
                  <SelectTrigger className="w-[130px] h-8">
                    <SelectValue placeholder="Module" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Modules</SelectItem>
                    {MODULES.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        <div className="flex items-center gap-2">
                          <m.icon className="h-3 w-3" />
                          {m.label}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={filterStatus} onValueChange={setFilterStatus}>
                  <SelectTrigger className="w-[130px] h-8">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Status</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="processing">Processing</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="failed">Failed</SelectItem>
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                  </SelectContent>
                </Select>

                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <Input
                    type="date"
                    value={filterDateFrom}
                    onChange={(e) => setFilterDateFrom(e.target.value)}
                    className="w-[130px] h-8"
                    placeholder="From"
                  />
                  <span className="text-muted-foreground">to</span>
                  <Input
                    type="date"
                    value={filterDateTo}
                    onChange={(e) => setFilterDateTo(e.target.value)}
                    className="w-[130px] h-8"
                    placeholder="To"
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[500px]">
                {loadingJobs ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin" />
                  </div>
                ) : filteredJobs.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    {jobs.length === 0 
                      ? "No generation jobs yet. Start your first one!"
                      : "No jobs match the current filters."}
                  </div>
                ) : (
                  <div className="space-y-4">
                    {filteredJobs.map((job) => (
                      <Card
                        key={job.id}
                        className={`cursor-pointer transition-colors hover:bg-muted/50 ${
                          selectedJob?.id === job.id ? "ring-2 ring-primary" : ""
                        }`}
                        onClick={() => setSelectedJob(job)}
                      >
                        <CardContent className="p-4">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              {getModuleIcon(job.module)}
                              <Badge variant="outline" className="capitalize">
                                {job.module}
                              </Badge>
                              <span className="font-medium">{job.topic}</span>
                              {job.question_type && job.question_type !== "mixed" && (
                                <Badge variant="secondary" className="text-xs">
                                  {job.question_type.replace(/_/g, " ")}
                                </Badge>
                              )}
                              {job.monologue && (
                                <Badge variant="outline" className="text-xs">Monologue</Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              {getStatusBadge(job.status)}
                              {(job.status === "processing" || job.status === "pending") && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    cancelJob(job.id);
                                  }}
                                  disabled={cancelingJobId === job.id}
                                  title="Cancel job"
                                >
                                  {cancelingJobId === job.id ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <X className="h-4 w-4" />
                                  )}
                                </Button>
                              )}
                            </div>
                          </div>
                          
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground mb-2">
                            <span>Difficulty: {job.difficulty}</span>
                            {job.module === 'speaking' && job.question_type && (
                              <span className="font-medium">
                                {job.question_type.toUpperCase() === 'FULL_TEST' ? 'Full Test' : 
                                 job.question_type.toUpperCase() === 'PART_1' ? 'Part 1' :
                                 job.question_type.toUpperCase() === 'PART_2' ? 'Part 2' :
                                 job.question_type.toUpperCase() === 'PART_3' ? 'Part 3' :
                                 job.question_type === 'mixed' ? null :
                                 job.question_type.replace(/_/g, ' ')}
                              </span>
                            )}
                            {job.module === 'writing' && job.question_type && (
                              <span className="font-medium">
                                {job.question_type.toUpperCase() === 'TASK_1' || job.question_type === 'task1' ? 'Task 1' :
                                 job.question_type.toUpperCase() === 'TASK_2' || job.question_type === 'task2' ? 'Task 2' :
                                 job.question_type.toUpperCase() === 'FULL_TEST' ? 'Full Test' :
                                 job.question_type === 'mixed' ? null :
                                 job.question_type.replace(/_/g, ' ')}
                              </span>
                            )}
                            {(job.module === 'reading' || job.module === 'listening') && job.question_type && job.question_type !== 'mixed' && (
                              <span className="font-medium">{job.question_type.replace(/_/g, ' ')}</span>
                            )}
                            <span className="ml-auto">{job.success_count + job.failure_count} / {job.quantity}</span>
                          </div>

                          {job.status === "processing" && (
                            <Progress
                              value={((job.success_count + job.failure_count) / job.quantity) * 100}
                              className="h-2"
                            />
                          )}

                          {job.status === "completed" && (
                            <div className="flex items-center gap-4 text-sm">
                              <span className="text-green-500 flex items-center gap-1">
                                <CheckCircle className="h-4 w-4" />
                                {job.success_count} success
                              </span>
                              {job.failure_count > 0 && (
                                <span className="text-red-500 flex items-center gap-1">
                                  <XCircle className="h-4 w-4" />
                                  {job.failure_count} failed
                                </span>
                              )}
                              {formatDuration(job.started_at, job.completed_at) && (
                                <span className="text-muted-foreground">
                                  {formatDuration(job.started_at, job.completed_at)}
                                </span>
                              )}
                            </div>
                          )}
                          
                          <div className="text-xs text-muted-foreground mt-2">
                            {new Date(job.created_at).toLocaleString()}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </div>

        {/* Selected Job Details */}
        {selectedJob && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    {getModuleIcon(selectedJob.module)}
                    Job Details: {selectedJob.topic}
                  </CardTitle>
                  <CardDescription>
                    Generated {selectedJob.module} tests • {selectedJob.difficulty} difficulty
                    {selectedJob.question_type && selectedJob.question_type !== "mixed" && (
                      <> • {selectedJob.question_type.replace(/_/g, " ")}</>
                    )}
                  </CardDescription>
                </div>
                <div className="flex gap-2">

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => publishTests(jobTests.filter(t => !t.is_published).map(t => t.id), true)}
                    disabled={jobTests.filter(t => !t.is_published).length === 0}
                  >
                    <Upload className="h-4 w-4 mr-2" />
                    Publish All
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {jobTests.length === 0 ? (
                <p className="text-muted-foreground text-center py-4">
                  No tests generated yet
                </p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {jobTests.map((test, index) => (
                    <Card key={test.id} className={test.status === "failed" ? "border-destructive/50" : ""}>
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between mb-2">
                          <span className="font-medium">Test #{index + 1}</span>
                          <div className="flex items-center gap-2">
                            {test.status === "failed" && (
                              <Badge variant="destructive">Failed</Badge>
                            )}
                            <Badge variant={test.is_published ? "default" : "secondary"}>
                              {test.is_published ? "Published" : "Draft"}
                            </Badge>
                          </div>
                        </div>
                        <div className="text-sm text-muted-foreground mb-3">
                          {test.voice_id && <p>Voice: {test.voice_id}</p>}
                          {test.accent && <p>Accent: {test.accent}</p>}
                          {test.question_type && (
                            <p>Type: {test.question_type.replace(/_/g, " ")}</p>
                          )}
                          <p>Status: {test.status}</p>
                        </div>
                        <div className="flex gap-2">
                          {test.status !== "failed" && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="flex-1"
                              onClick={() => publishTests([test.id], !test.is_published)}
                            >
                              {test.is_published ? "Unpublish" : "Publish"}
                            </Button>
                          )}
                          {test.status === "failed" && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="flex-1"
                              onClick={() => retryTest(test)}
                              disabled={retryingTestId === test.id}
                            >
                              {retryingTestId === test.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <>
                                  <RotateCcw className="h-4 w-4 mr-1" />
                                  Retry
                                </>
                              )}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => setPreviewTest(test)}
                            disabled={test.status === "failed"}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive hover:text-destructive"
                            onClick={() => setDeleteTestId(test.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}

              {/* Generation Summary */}
              {selectedJob.status === "completed" && (
                <div className="mt-6 bg-muted/50 rounded-lg p-4">
                  <h4 className="font-medium mb-2">Generation Summary</h4>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    <div>
                      <p className="text-muted-foreground">Requested</p>
                      <p className="font-medium text-lg">{selectedJob.quantity}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Successful</p>
                      <p className="font-medium text-lg text-green-500">{selectedJob.success_count}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Failed</p>
                      <p className="font-medium text-lg text-red-500">{selectedJob.failure_count}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Duration</p>
                      <p className="font-medium text-lg">
                        {formatDuration(selectedJob.started_at, selectedJob.completed_at) || "N/A"}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Error Log */}
              {selectedJob.error_log && selectedJob.error_log.length > 0 && (
                <div className="mt-6">
                  <h4 className="font-medium mb-2 text-destructive">Error Log</h4>
                  <div className="bg-destructive/10 rounded-lg p-4 space-y-2 max-h-48 overflow-y-auto">
                    {selectedJob.error_log.map((err, i) => (
                      <div key={i} className="text-sm">
                        <span className="font-medium">Test #{err.index + 1}:</span>{" "}
                        {err.error}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Preview Dialog */}
      <GeneratedTestPreview
        open={!!previewTest}
        onOpenChange={(open) => !open && setPreviewTest(null)}
        test={previewTest}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteTestId} onOpenChange={(open) => !open && setDeleteTestId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Test</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this test? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTestId && deleteTest(deleteTestId)}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
