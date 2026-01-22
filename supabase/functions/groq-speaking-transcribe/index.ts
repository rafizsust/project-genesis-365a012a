import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getFromR2 } from "../_shared/r2Client.ts";

/**
 * SINGLE-MODEL WHISPER TRANSCRIPTION ENGINE v1.0
 * 
 * Industry-standard approach: Good Preprocessing → Single Model → Robust Post-processing
 * 
 * This simplified pipeline uses only whisper-large-v3-turbo for:
 * - Better noise handling
 * - Fewer hallucinations
 * - Faster processing
 * 
 * The client-side preprocessing handles:
 * - Volume normalization (fixes missing quiet speech)
 * - 16kHz resampling (Whisper's native format)
 * - 80Hz high-pass filter (removes rumble/hum)
 * 
 * This function handles:
 * - Robust post-processing to remove repetitions
 * - Hallucination detection and removal
 * - Simple retry logic
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// =============================================================================
// CONFIGURATION
// =============================================================================

const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const WHISPER_MODEL = 'whisper-large-v3-turbo';
const INTER_SEGMENT_DELAY_MS = 1500; // Increased for safety

// =============================================================================
// HALLUCINATION PATTERNS
// =============================================================================

const HALLUCINATION_PATTERNS = {
  // Non-English languages (Whisper often hallucinates in other languages)
  german: /\b(wieder|und|oder|nicht|aber|danke|bitte|ja|nein|gut|sehr|ich|sie|wir|das|ist|haben|werden|kann|muss|soll)\b/gi,
  spanish: /\b(hablando|como|pero|para|gracias|bueno|entonces|porque|tambien|esta|este|una|los|las|del|por|con|sin|sobre)\b/gi,
  french: /\b(merci|bonjour|alors|peut|tres|bien|donc|mais|avec|pour|dans|cette|sont|nous|vous|leur|faire|etre)\b/gi,
  portuguese: /\b(obrigado|muito|entao|porque|ainda|agora|mais|isso|esse|esta|voce|nao|sim|com|por|para)\b/gi,
  italian: /\b(grazie|molto|allora|perche|ancora|adesso|questo|quello|sono|siamo|hanno|fare|essere|potere)\b/gi,
  dutch: /\b(bedankt|heel|omdat|nog|steeds|dit|dat|zijn|hebben|worden|kunnen|moeten|zullen)\b/gi,

  // CJK and other scripts
  cjk: /[\u4e00-\u9fff\u3400-\u4dbf\uac00-\ud7af\u3040-\u309f\u30a0-\u30ff]/g,
  arabic: /[\u0600-\u06ff\u0750-\u077f]/g,
  cyrillic: /[\u0400-\u04ff]/g,
  hebrew: /[\u0590-\u05ff]/g,
  thai: /[\u0e00-\u0e7f]/g,
  devanagari: /[\u0900-\u097f]/g,

  // Common Whisper artifacts
  youtubeEndings: /\b(thank\s*you\s*(for\s*)?(watching|listening|viewing)|please\s*(like|subscribe|share)|don'?t\s*forget\s*to\s*subscribe)\b/gi,
  podcastArtifacts: /\b(this\s*episode|brought\s*to\s*you\s*by|sponsored\s*by|our\s*sponsor)\b/gi,
  subtitleArtifacts: /\b(subtitles?\s*by|captions?\s*by|transcribed?\s*by)\b/gi,

  // Garbage patterns
  repeatedPunctuation: /[,."'\s]{5,}/g,
  manyEllipses: /\.{4,}/g,
  placeholder: /\b(XXX+|___+|\*\*\*+)\b/gi,

  // Sound descriptions that shouldn't appear in speech
  soundDescriptions: /\[(music|applause|laughter|silence|inaudible|crosstalk)\]/gi,
};

const STRIP_START_PATTERNS = [
  /^(ielts\s+)?speaking\s+test\.?\s*(interview)?\.?\s*/gi,
  /^welcome\s+to\s+(the\s+)?(ielts\s+)?speaking\s+test\.?\s*/gi,
  /^this\s+is\s+(an?\s+)?ielts\s+speaking\.?\s*/gi,
  /^okay\.?\s+so\.?\s*/gi,
];

const STRIP_END_PATTERNS = [
  /\s*thank\s*you\.?\s*$/gi,
  /\s*thanks\.?\s*$/gi,
  /\s*bye\.?\s*$/gi,
  /\s*goodbye\.?\s*$/gi,
  /\s*\.{3,}\s*$/g,
];

// =============================================================================
// INTERFACES
// =============================================================================

interface WhisperResponse {
  text: string;
  segments?: Array<{
    text: string;
    start: number;
    end: number;
    no_speech_prob?: number;
    avg_logprob?: number;
  }>;
  duration?: number;
  language?: string;
}

type WhisperFailure = {
  ok: false;
  status?: number;
  message: string;
  bodySnippet?: string;
};

type WhisperSuccess = {
  ok: true;
  result: WhisperResponse;
};

type WhisperCallResult = WhisperSuccess | WhisperFailure;

class WhisperHTTPError extends Error {
  status: number;
  bodySnippet?: string;
  constructor(message: string, status: number, bodySnippet?: string) {
    super(message);
    this.name = 'WhisperHTTPError';
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}

interface SegmentTranscription {
  segmentKey: string;
  partNumber: number;
  questionNumber: number;
  text: string;
  duration: number;
  wordCount: number;
  avgConfidence: number;
  avgLogprob: number;
  fillerWords: string[];
  longPauses: { start: number; end: number; duration: number }[];
  noSpeechProb?: number;
  confidence: string;
  method: string;
  agreementScore: number;
  issues: string[];
}

function extractFillerWords(text: string): string[] {
  const fillers = ['um', 'uh', 'er', 'ah', 'like', 'you know', 'i mean'];
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (const f of fillers) {
    const re = new RegExp(`\\b${f.replace(/\s+/g, '\\s+')}\\b`, 'g');
    const matches = lower.match(re);
    if (matches?.length) found.push(...Array(matches.length).fill(f));
  }
  return found;
}

function extractWhisperMeta(result: WhisperResponse | null): {
  avgLogprob: number;
  noSpeechProb: number;
  longPauses: { start: number; end: number; duration: number }[];
} {
  const segments = result?.segments ?? [];
  const logprobs = segments
    .map(s => (typeof s.avg_logprob === 'number' && Number.isFinite(s.avg_logprob) ? s.avg_logprob : null))
    .filter((v): v is number => v !== null);
  const noSpeech = segments
    .map(s => (typeof s.no_speech_prob === 'number' && Number.isFinite(s.no_speech_prob) ? s.no_speech_prob : null))
    .filter((v): v is number => v !== null);

  const avgLogprob = logprobs.length ? logprobs.reduce((a, b) => a + b, 0) / logprobs.length : -1;
  const noSpeechProb = noSpeech.length ? noSpeech.reduce((a, b) => a + b, 0) / noSpeech.length : 0;

  const longPauses: { start: number; end: number; duration: number }[] = [];
  for (let i = 0; i < segments.length - 1; i++) {
    const end = segments[i].end;
    const start = segments[i + 1].start;
    const gap = start - end;
    if (Number.isFinite(gap) && gap >= 2) {
      longPauses.push({ start: end, end: start, duration: gap });
    }
  }

  return { avgLogprob, noSpeechProb, longPauses };
}

// =============================================================================
// WHISPER API CALL
// =============================================================================

async function callWhisperAPI(
  audioBlob: Blob,
  apiKey: string,
  retryCount = 0
): Promise<WhisperCallResult> {
  const MAX_RETRIES = 2;

  try {
    const fileExtension = audioBlob.type.includes('mp3') || audioBlob.type.includes('mpeg')
      ? 'mp3'
      : audioBlob.type.includes('wav')
        ? 'wav'
        : 'webm';

    // Simplified, focused prompt
    const prompt = `Verbatim English transcription. Start from the very first word. Include filler words (um, uh, er, like, you know). Do NOT repeat any phrases. Do NOT add words not spoken. Silence produces no text.`;

    const formData = new FormData();
    formData.append('file', audioBlob, `audio.${fileExtension}`);
    formData.append('model', WHISPER_MODEL);
    formData.append('response_format', 'verbose_json');
    formData.append('language', 'en');
    formData.append('temperature', '0');
    formData.append('prompt', prompt);

    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      const snippet = errorText?.slice(0, 300);

      console.error(`[groq-speaking-transcribe] Whisper HTTP ${response.status}: ${snippet}`);

      // Retry on 5xx errors
      if (response.status >= 500 && retryCount < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1000 * (retryCount + 1)));
        return callWhisperAPI(audioBlob, apiKey, retryCount + 1);
      }

      // For 429, surface a typed error so the caller can key-switch / backoff.
      if (response.status === 429) {
        throw new WhisperHTTPError(`Whisper rate limited (429)`, 429, snippet);
      }

      return { ok: false, status: response.status, message: `Whisper HTTP ${response.status}`, bodySnippet: snippet };
    }

    const result = await response.json();
    
    // Validate: if Whisper returns empty text, treat as failure
    if (!result.text || result.text.trim().length === 0) {
      console.warn(`[groq-speaking-transcribe] Whisper returned empty text - treating as failure`);
      return { ok: false, message: `Whisper returned empty text`, bodySnippet: 'Empty response' };
    }
    
    return { ok: true, result };
  } catch (err) {
    // Bubble up rate limits (we handle key cooldowns upstream)
    if (err instanceof WhisperHTTPError && err.status === 429) {
      throw err;
    }

    console.error(`[groq-speaking-transcribe] Whisper exception:`, err);
    if (retryCount < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 1000 * (retryCount + 1)));
      return callWhisperAPI(audioBlob, apiKey, retryCount + 1);
    }
    return { ok: false, message: `Whisper exception`, bodySnippet: String((err as any)?.message || err).slice(0, 300) };
  }
}

// =============================================================================
// POST-PROCESSING (Robust repetition removal)
// =============================================================================

/**
 * Post-process transcript to remove repetitions and hallucinations.
 * This is the KEY to fixing "at home, at home, at home" issues.
 */
function postProcessTranscript(text: string): string {
  let cleaned = text;
  
  // Remove 2-3 word phrase repetitions: "at home, at home, at home" → "at home"
  cleaned = cleaned.replace(/\b((?:\w+\s+){1,2}\w+)((?:\s*,?\s*\1)+)/gi, '$1');
  
  // Remove single word repetitions: "the the" → "the"
  cleaned = cleaned.replace(/\b(\w+)((?:\s+\1)+)\b/gi, '$1');
  
  // Remove comma-separated word repetitions: "home, home, home" → "home"
  cleaned = cleaned.replace(/\b(\w{2,})(,\s*\1)+\b/gi, '$1');
  
  // Apply existing cleanTranscript logic
  cleaned = cleanTranscript(cleaned);
  
  return cleaned;
}

function detectHallucinations(text: string): string[] {
  const detected: string[] = [];

  for (const [name, pattern] of Object.entries(HALLUCINATION_PATTERNS)) {
    if (pattern.test(text)) {
      detected.push(name);
      pattern.lastIndex = 0;
    }
  }

  return detected;
}

function hasDuplication(text: string): boolean {
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  if (words.length < 16) return false;

  // Check if second half significantly overlaps with first half
  const halfLen = Math.floor(words.length / 2);
  const firstHalf = words.slice(0, halfLen);
  const secondHalf = words.slice(halfLen);

  const firstSet = new Set(firstHalf);
  const overlapCount = secondHalf.filter(w => firstSet.has(w)).length;
  const overlapRatio = overlapCount / halfLen;

  // Check for exact phrase repetition
  const quarterLen = Math.floor(words.length / 4);
  if (quarterLen >= 4) {
    const firstQuarter = words.slice(0, quarterLen).join(' ');
    const rest = words.slice(quarterLen).join(' ');
    if (rest.includes(firstQuarter)) {
      return true;
    }
  }

  return overlapRatio > 0.65;
}

function removeDuplication(text: string): string {
  const words = text.split(/\s+/);
  if (words.length < 16) return text;

  const halfLen = Math.floor(words.length / 2);

  // Check various split points
  for (let splitPoint = halfLen; splitPoint >= Math.floor(words.length * 0.4); splitPoint--) {
    const firstPart = words.slice(0, splitPoint).join(' ').toLowerCase();
    const secondPart = words.slice(splitPoint).join(' ').toLowerCase();

    const firstWords = firstPart.split(/\s+/).slice(0, 5).join(' ');
    if (secondPart.startsWith(firstWords) || secondPart.includes(firstWords)) {
      console.log(`[groq-speaking-transcribe] Removed duplication at word ${splitPoint}`);
      return words.slice(0, splitPoint).join(' ');
    }
  }

  if (hasDuplication(text)) {
    return words.slice(0, halfLen).join(' ');
  }

  return text;
}

function cleanTranscript(text: string): string {
  let cleaned = text;

  // Remove start patterns
  for (const pattern of STRIP_START_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }

  // Remove end patterns
  for (const pattern of STRIP_END_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }

  // Remove garbage
  cleaned = cleaned.replace(HALLUCINATION_PATTERNS.repeatedPunctuation, ' ');
  cleaned = cleaned.replace(HALLUCINATION_PATTERNS.manyEllipses, '...');
  cleaned = cleaned.replace(HALLUCINATION_PATTERNS.placeholder, '[unclear]');
  cleaned = cleaned.replace(HALLUCINATION_PATTERNS.soundDescriptions, '');

  // Remove non-English text
  const nonEnglishPatterns = [
    HALLUCINATION_PATTERNS.german,
    HALLUCINATION_PATTERNS.spanish,
    HALLUCINATION_PATTERNS.french,
    HALLUCINATION_PATTERNS.portuguese,
    HALLUCINATION_PATTERNS.italian,
    HALLUCINATION_PATTERNS.dutch,
    HALLUCINATION_PATTERNS.cjk,
    HALLUCINATION_PATTERNS.arabic,
    HALLUCINATION_PATTERNS.cyrillic,
    HALLUCINATION_PATTERNS.hebrew,
    HALLUCINATION_PATTERNS.thai,
    HALLUCINATION_PATTERNS.devanagari,
  ];

  for (const pattern of nonEnglishPatterns) {
    cleaned = cleaned.replace(pattern, '');
  }

  // Remove YouTube/podcast artifacts
  cleaned = cleaned.replace(HALLUCINATION_PATTERNS.youtubeEndings, '');
  cleaned = cleaned.replace(HALLUCINATION_PATTERNS.podcastArtifacts, '');
  cleaned = cleaned.replace(HALLUCINATION_PATTERNS.subtitleArtifacts, '');

  // Remove duplication
  cleaned = removeDuplication(cleaned);

  // Fix common immediate stutters like "my personal is my personal is".
  cleaned = cleaned.replace(/\b(\w+)(?:\s+\1\b)+/gi, '$1');
  cleaned = cleaned.replace(/\b(\w+\s+\w+)(?:\s+\1\b)+/gi, '$1');

  // Normalize whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}

function validateWordCount(text: string, audioDurationSeconds: number): { isValid: boolean; issue: string | null } {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const wordCount = words.length;

  // Expected words based on speaking rate (60-200 WPM for IELTS)
  const minExpectedWords = Math.floor(audioDurationSeconds * 1.0); // 60 WPM
  const maxExpectedWords = Math.ceil(audioDurationSeconds * 3.5);   // 210 WPM

  if (wordCount < minExpectedWords * 0.3) {
    return { isValid: false, issue: `Very few words (${wordCount}) for ${audioDurationSeconds.toFixed(1)}s audio` };
  }

  if (wordCount > maxExpectedWords * 1.5) {
    return { isValid: false, issue: `Too many words (${wordCount}) for ${audioDurationSeconds.toFixed(1)}s - likely hallucination` };
  }

  return { isValid: true, issue: null };
}

// =============================================================================
// SINGLE-MODEL TRANSCRIPTION
// =============================================================================

async function transcribeSegment(
  audioBlob: Blob,
  apiKey: string,
  segmentKey: string
): Promise<{
  text: string;
  duration: number;
  wordCount: number;
  confidence: number;
  avgLogprob: number;
  noSpeechProb: number;
  fillerWords: string[];
  longPauses: { start: number; end: number; duration: number }[];
  issues: string[];
}> {
  const issues: string[] = [];
  
  console.log(`[groq-speaking-transcribe] Transcribing ${segmentKey}...`);
  
  // Single API call
  let result = await callWhisperAPI(audioBlob, apiKey);
  
  if (!result.ok) {
    // Retry once after 2 seconds
    console.log(`[groq-speaking-transcribe] ${segmentKey}: First attempt failed, retrying...`);
    await new Promise(r => setTimeout(r, 2000));
    result = await callWhisperAPI(audioBlob, apiKey);
    
    if (!result.ok) {
      console.error(`[groq-speaking-transcribe] ${segmentKey}: Both attempts failed - ${result.message}`);
      return {
        text: '',
        duration: 0,
        wordCount: 0,
        confidence: 0,
        avgLogprob: -1,
        noSpeechProb: 0,
        fillerWords: [],
        longPauses: [],
        issues: ['Transcription failed after retry'],
      };
    }
  }
  
  const whisperResponse = result.result;
  let text = whisperResponse.text || '';
  
  // Apply post-processing to clean up repetitions and hallucinations
  text = postProcessTranscript(text);
  
  // Check for remaining hallucinations
  const hallucinations = detectHallucinations(text);
  if (hallucinations.length > 0) {
    issues.push(`Hallucinations detected: ${hallucinations.join(', ')}`);
  }
  
  // Validate word count
  const wordValidation = validateWordCount(text, whisperResponse.duration || 0);
  if (!wordValidation.isValid && wordValidation.issue) {
    issues.push(wordValidation.issue);
  }
  
  // Extract metadata
  const meta = extractWhisperMeta(whisperResponse);
  const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
  const fillerWords = extractFillerWords(text);
  
  // Calculate confidence from avgLogprob (logprob of -1 = 0 confidence, 0 = 1.0 confidence)
  const confidence = Math.max(0, Math.min(1, meta.avgLogprob + 1));
  
  console.log(`[groq-speaking-transcribe] ${segmentKey}: "${text.slice(0, 60)}..." (${wordCount} words, conf=${confidence.toFixed(2)})`);
  
  return {
    text,
    duration: whisperResponse.duration || 0,
    wordCount,
    confidence,
    avgLogprob: meta.avgLogprob,
    noSpeechProb: meta.noSpeechProb,
    fillerWords,
    longPauses: meta.longPauses,
    issues,
  };
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

serve(async (req) => {
  console.log(`[groq-speaking-transcribe] Request at ${new Date().toISOString()}`);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { jobId } = await req.json();

    if (!jobId) {
      return new Response(JSON.stringify({ error: 'Missing jobId' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[groq-speaking-transcribe] Processing job ${jobId}`);

    // Fetch job details
    const { data: job, error: jobError } = await supabaseService
      .from('speaking_evaluation_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (jobError || !job) {
      console.error(`[groq-speaking-transcribe] Job not found:`, jobError);
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Build question ID mapping
    const { data: testRow } = await supabaseService
      .from('ai_practice_tests')
      .select('payload')
      .eq('id', job.test_id)
      .maybeSingle();

    const payload = (testRow as any)?.payload;
    const questionIdToNumber = buildQuestionIdToNumberMap(payload);

    // Update job status
    await supabaseService
      .from('speaking_evaluation_jobs')
      .update({
        status: 'processing',
        stage: 'transcribing',
        heartbeat_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    // Get ONE Groq API key (simplified from dual-key approach)
    console.log(`[groq-speaking-transcribe] Checking out API key...`);
    
    const keyResult = await supabaseService.rpc('checkout_groq_key_for_stt', {
      p_job_id: String(jobId),
      p_lock_duration_seconds: 600,
      p_part_number: 1,
    });

    if (keyResult.error || !keyResult.data || keyResult.data.length === 0) {
      console.error(`[groq-speaking-transcribe] No Groq keys available:`, keyResult.error);
      throw new Error('No Groq API keys available');
    }

    const apiKey = keyResult.data[0].out_key_value;
    const keyId = keyResult.data[0].out_key_id;

    console.log(`[groq-speaking-transcribe] Using key ${keyId?.slice(0, 8)}...`);

    await supabaseService
      .from('speaking_evaluation_jobs')
      .update({ groq_stt_key_id: keyId })
      .eq('id', jobId);

    // Process segments
    const filePaths = job.file_paths as Record<string, string>;
    const segments = Object.entries(filePaths);
    const transcriptions: SegmentTranscription[] = [];
    let totalAudioSeconds = 0;

    console.log(`[groq-speaking-transcribe] Processing ${segments.length} segments with single-turbo pipeline`);

    for (let i = 0; i < segments.length; i++) {
      const [segmentKey, filePath] = segments[i];

      // Inter-segment delay
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, INTER_SEGMENT_DELAY_MS));
      }

      // Update heartbeat
      await supabaseService
        .from('speaking_evaluation_jobs')
        .update({ heartbeat_at: new Date().toISOString() })
        .eq('id', jobId);

      console.log(`[groq-speaking-transcribe] Processing segment ${i + 1}/${segments.length}: ${segmentKey}`);

      try {
        // Parse segment key
        const partMatch = segmentKey.match(/part(\d+)/i) || segmentKey.match(/^(\d+)-/);
        const partNumber = partMatch ? parseInt(partMatch[1]) : 1;

        const qUuidMatch = segmentKey.match(/q([0-9a-f\-]{8,})/i);
        const qUuid = qUuidMatch?.[1];
        const mappedQuestionNumber = qUuid ? questionIdToNumber[qUuid] : undefined;

        const qNumMatch = segmentKey.match(/q(\d+)\b/i) || segmentKey.match(/-(\d+)$/);
        const parsedQuestionNumber = qNumMatch ? parseInt(qNumMatch[1]) : 1;
        const questionNumber = typeof mappedQuestionNumber === 'number' ? mappedQuestionNumber : parsedQuestionNumber;

        // Download audio from R2
        const audioBlob = await downloadFromR2(filePath);

        if (!audioBlob) {
          console.error(`[groq-speaking-transcribe] Failed to download audio: ${filePath}`);
          continue;
        }

        // Run single-model transcription
        const result = await transcribeSegment(audioBlob, apiKey, segmentKey);

        transcriptions.push({
          segmentKey,
          partNumber,
          questionNumber,
          text: result.text,
          duration: result.duration,
          wordCount: result.wordCount,
          avgConfidence: result.confidence,
          avgLogprob: result.avgLogprob,
          fillerWords: result.fillerWords,
          longPauses: result.longPauses,
          noSpeechProb: result.noSpeechProb,
          confidence: result.confidence > 0.7 ? 'high' : result.confidence > 0.4 ? 'medium' : 'low',
          method: 'single-turbo',
          agreementScore: 1, // Not applicable for single model
          issues: result.issues,
        });

        totalAudioSeconds += result.duration;

        console.log(`[groq-speaking-transcribe] ${segmentKey}: ${result.wordCount} words, ${result.confidence > 0.7 ? 'high' : result.confidence > 0.4 ? 'medium' : 'low'} confidence`);

      } catch (segmentError: any) {
        console.error(`[groq-speaking-transcribe] Segment ${segmentKey} error:`, segmentError.message);

        if (segmentError instanceof WhisperHTTPError && segmentError.status === 429) {
          console.error(`[groq-speaking-transcribe] Rate limit hit on segment ${segmentKey}`);
          await supabaseService.rpc('mark_groq_key_rpm_limited', {
            p_key_id: keyId,
            p_cooldown_seconds: 60,
          });
          throw new Error('RATE_LIMIT: Groq RPM limit hit');
        }

        if (segmentError.message?.includes('429') || segmentError.message?.includes('rate limit')) {
          await supabaseService.rpc('mark_groq_key_rpm_limited', {
            p_key_id: keyId,
            p_cooldown_seconds: 60,
          });
          throw new Error('RATE_LIMIT: Groq RPM limit hit');
        }
      }
    }

    // Record ASH usage
    if (totalAudioSeconds > 0) {
      await supabaseService.rpc('record_groq_ash_usage', {
        p_key_id: keyId,
        p_audio_seconds: Math.ceil(totalAudioSeconds),
      });
      console.log(`[groq-speaking-transcribe] Recorded ${Math.ceil(totalAudioSeconds)}s ASH usage`);
    }

    // Store results
    const transcriptionResult = {
      transcriptions,
      totalAudioSeconds,
      segmentCount: transcriptions.length,
      pipelineVersion: 'single-turbo-1.0',
      processedAt: new Date().toISOString(),
    };

    await supabaseService
      .from('speaking_evaluation_jobs')
      .update({
        transcription_result: transcriptionResult,
        stage: 'pending_groq_eval',
        status: 'pending',
        heartbeat_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    console.log(`[groq-speaking-transcribe] Transcription complete. ${transcriptions.length} segments, ${totalAudioSeconds.toFixed(1)}s audio`);

    // Trigger evaluation
    const evalUrl = `${supabaseUrl}/functions/v1/groq-speaking-evaluate`;
    fetch(evalUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({ jobId }),
    }).catch(err => {
      console.error('[groq-speaking-transcribe] Failed to trigger evaluate:', err);
    });

    return new Response(JSON.stringify({
      success: true,
      segmentsTranscribed: transcriptions.length,
      totalAudioSeconds,
      pipelineVersion: 'single-turbo-1.0',
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[groq-speaking-transcribe] Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function buildQuestionIdToNumberMap(payload: any): Record<string, number> {
  const map: Record<string, number> = {};
  const parts = Array.isArray(payload?.speakingParts) ? payload.speakingParts : [];
  for (const p of parts) {
    const questions = Array.isArray(p?.questions) ? p.questions : [];
    for (const q of questions) {
      const idRaw = typeof q?.id === 'string' ? q.id : null;
      const n = typeof q?.question_number === 'number' ? q.question_number : Number(q?.question_number);
      const id = idRaw ? idRaw.replace(/^q/i, '') : null;
      if (id && Number.isFinite(n)) map[id] = n;
    }
  }
  return map;
}

async function downloadFromR2(filePath: string): Promise<Blob | null> {
  try {
    console.log(`[groq-speaking-transcribe] Downloading from R2: ${filePath}`);

    const result = await getFromR2(filePath);

    if (!result.success || !result.bytes) {
      console.error(`[groq-speaking-transcribe] R2 download error:`, result.error);
      return null;
    }

    const arrayBuffer = result.bytes.slice().buffer as ArrayBuffer;
    const blob = new Blob([arrayBuffer], { type: result.contentType || 'audio/mpeg' });
    console.log(`[groq-speaking-transcribe] Downloaded ${result.bytes.length} bytes`);
    return blob;
  } catch (err: any) {
    console.error(`[groq-speaking-transcribe] Download exception:`, err.message);
    return null;
  }
}
