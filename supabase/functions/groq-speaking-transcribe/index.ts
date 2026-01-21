import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getFromR2 } from "../_shared/r2Client.ts";

/**
 * DUAL-WHISPER TRANSCRIPTION ENGINE v2.1
 * 
 * Production-grade transcription using BOTH Groq Whisper models:
 * - whisper-large-v3: Better vocabulary accuracy
 * - whisper-large-v3-turbo: Better noise handling, fewer hallucinations
 * 
 * The engine runs both models and intelligently merges results based on
 * agreement, hallucination detection, and validation rules.
 * 
 * v2.1 Changes:
 * - Two separate API keys for V3 and Turbo to avoid rate limits
 * - Parallel model calls when keys are different
 * - Sequential calls with 300ms delay when keys are same
 * - Empty text validation for failure detection
 * - Completeness offset detection for missing first sentences
 * - Better merge logic for more complete transcripts
 * 
 * NO browser transcripts are used - they are too unreliable.
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
const WHISPER_V3 = 'whisper-large-v3';
const WHISPER_TURBO = 'whisper-large-v3-turbo';
const INTER_SEGMENT_DELAY_MS = 1000; // Increased delay between segments
const INTER_MODEL_DELAY_MS = 300; // Delay between model calls when using same key

// If Turbo repeatedly fails within a job, stop calling it to reduce errors/cost.
const TURBO_FAILURE_DISABLE_THRESHOLD = 2;

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

interface DualWhisperResult {
  finalText: string;
  confidence: 'high' | 'medium' | 'low' | 'very-low';
  method: 'consensus' | 'v3-selected' | 'turbo-selected' | 'merged' | 'single-fallback';
  v3Text: string | null;
  turboText: string | null;
  agreementScore: number;
  duration: number;
  issues: string[];
  wordCount: number;
  // Metadata used downstream by groq-speaking-evaluate
  avgLogprob: number;
  noSpeechProb: number;
  avgConfidence: number;
  fillerWords: string[];
  longPauses: { start: number; end: number; duration: number }[];
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
// WHISPER API CALLS
// =============================================================================

async function callWhisperAPI(
  audioBlob: Blob,
  apiKey: string,
  model: string,
  retryCount = 0
): Promise<WhisperCallResult> {
  const MAX_RETRIES = 2;

  try {
    const fileExtension = audioBlob.type.includes('mp3') || audioBlob.type.includes('mpeg')
      ? 'mp3'
      : audioBlob.type.includes('wav')
        ? 'wav'
        : 'webm';

    // Updated prompt with critical instruction to not skip beginning
    const prompt = `Verbatim English transcription of an IELTS speaking test response.
Rules:
- CRITICAL: Start transcribing from the VERY FIRST syllable. Do NOT skip the beginning.
- Transcribe EXACTLY what is spoken, word for word
- Include filler words: um, uh, er, like, you know, I mean
- Include false starts and self-corrections
- Silence or noise = NO text output
- Do NOT add any words that weren't spoken
- Do NOT translate or interpret
- English language ONLY`;

    const formData = new FormData();
    formData.append('file', audioBlob, `audio.${fileExtension}`);
    formData.append('model', model);
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

      console.error(`[DualWhisper] ${model} HTTP ${response.status}: ${snippet}`);

      // Retry on 5xx errors
      if (response.status >= 500 && retryCount < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1000 * (retryCount + 1)));
        return callWhisperAPI(audioBlob, apiKey, model, retryCount + 1);
      }

      // For 429, surface a typed error so the caller can key-switch / backoff.
      if (response.status === 429) {
        throw new WhisperHTTPError(`${model} rate limited (429)`, 429, snippet);
      }

      return { ok: false, status: response.status, message: `${model} HTTP ${response.status}`, bodySnippet: snippet };
    }

    const result = await response.json();
    
    // Validate: if Whisper returns empty text, treat as failure
    if (!result.text || result.text.trim().length === 0) {
      console.warn(`[DualWhisper] ${model} returned empty text - treating as failure`);
      return { ok: false, message: `${model} returned empty text`, bodySnippet: 'Empty response' };
    }
    
    return { ok: true, result };
  } catch (err) {
    // Bubble up rate limits (we handle key cooldowns upstream)
    if (err instanceof WhisperHTTPError && err.status === 429) {
      throw err;
    }

    console.error(`[DualWhisper] ${model} exception:`, err);
    if (retryCount < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 1000 * (retryCount + 1)));
      return callWhisperAPI(audioBlob, apiKey, model, retryCount + 1);
    }
    return { ok: false, message: `${model} exception`, bodySnippet: String((err as any)?.message || err).slice(0, 300) };
  }
}

// =============================================================================
// VALIDATION & CLEANING FUNCTIONS
// =============================================================================

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
      console.log(`[DualWhisper] Removed duplication at word ${splitPoint}`);
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

function countImmediateRepeats(text: string): number {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  let repeats = 0;
  for (let i = 1; i < words.length; i++) {
    if (words[i] === words[i - 1]) repeats++;
  }
  return repeats;
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

/**
 * Check if one transcript contains the other's start later in the text.
 * This detects if one model skipped the beginning.
 * Returns 'v3' if V3 is more complete, 'turbo' if Turbo is more complete, or null if unclear.
 */
function checkCompletenessOffset(v3Text: string, turboText: string): 'v3' | 'turbo' | null {
  const v3Words = v3Text.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const turboWords = turboText.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  
  if (v3Words.length < 5 || turboWords.length < 5) return null;
  
  // Get first 5 meaningful words from each
  const v3Start = v3Words.slice(0, 5).join(' ');
  const turboStart = turboWords.slice(0, 5).join(' ');
  
  const turboFull = turboWords.join(' ');
  const v3Full = v3Words.join(' ');
  
  // Check if V3's start appears later in Turbo's text (V3 skipped beginning)
  const v3StartInTurbo = turboFull.indexOf(v3Start);
  if (v3StartInTurbo > 15) {
    console.log(`[DualWhisper] V3 start found at offset ${v3StartInTurbo} in Turbo - Turbo is more complete`);
    return 'turbo';
  }
  
  // Check if Turbo's start appears later in V3's text (Turbo skipped beginning)
  const turboStartInV3 = v3Full.indexOf(turboStart);
  if (turboStartInV3 > 15) {
    console.log(`[DualWhisper] Turbo start found at offset ${turboStartInV3} in V3 - V3 is more complete`);
    return 'v3';
  }
  
  return null;
}

// =============================================================================
// AGREEMENT CALCULATION (LCS-based)
// =============================================================================

function longestCommonSubsequence(arr1: string[], arr2: string[]): number {
  const m = arr1.length;
  const n = arr2.length;

  const dp: number[] = new Array(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    let prev = 0;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      if (arr1[i - 1] === arr2[j - 1]) {
        dp[j] = prev + 1;
      } else {
        dp[j] = Math.max(dp[j], dp[j - 1]);
      }
      prev = temp;
    }
  }

  return dp[n];
}

function calculateAgreement(text1: string, text2: string): number {
  const words1 = text1.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  const words2 = text2.toLowerCase().split(/\s+/).filter(w => w.length > 1);

  if (words1.length === 0 && words2.length === 0) return 1;
  if (words1.length === 0 || words2.length === 0) return 0;

  const lcs = longestCommonSubsequence(words1, words2);
  return lcs / Math.max(words1.length, words2.length);
}

// =============================================================================
// DUAL-WHISPER MERGE LOGIC
// =============================================================================

async function dualWhisperTranscribe(
  audioBlob: Blob,
  v3ApiKey: string,
  turboApiKey: string,
  segmentKey: string,
  options?: { disableTurbo?: boolean }
): Promise<DualWhisperResult> {
  const issues: string[] = [];
  let duration = 0;

  const disableTurbo = Boolean(options?.disableTurbo);
  const sameKey = v3ApiKey === turboApiKey;
  
  console.log(`[DualWhisper] ${segmentKey}: Calling models (turbo=${disableTurbo ? 'disabled' : 'enabled'}, sameKey=${sameKey})...`);

  let v3Call: WhisperCallResult;
  let turboCall: WhisperCallResult;

  if (disableTurbo) {
    // Only call V3
    v3Call = await callWhisperAPI(audioBlob, v3ApiKey, WHISPER_V3);
    turboCall = { ok: false, message: 'turbo disabled' };
  } else if (sameKey) {
    // Sequential calls with delay when using same key
    console.log(`[DualWhisper] ${segmentKey}: Same key - calling V3 first, then Turbo with ${INTER_MODEL_DELAY_MS}ms delay`);
    v3Call = await callWhisperAPI(audioBlob, v3ApiKey, WHISPER_V3);
    await new Promise(r => setTimeout(r, INTER_MODEL_DELAY_MS));
    turboCall = await callWhisperAPI(audioBlob, turboApiKey, WHISPER_TURBO);
  } else {
    // Parallel calls when using different keys
    console.log(`[DualWhisper] ${segmentKey}: Different keys - calling models in parallel`);
    [v3Call, turboCall] = await Promise.all([
      callWhisperAPI(audioBlob, v3ApiKey, WHISPER_V3),
      callWhisperAPI(audioBlob, turboApiKey, WHISPER_TURBO),
    ]);
  }

  const v3Result = v3Call.ok ? v3Call.result : null;
  const turboResult = turboCall.ok ? turboCall.result : null;

  const v3Text = v3Result?.text ? cleanTranscript(v3Result.text) : null;
  const turboText = turboResult?.text ? cleanTranscript(turboResult.text) : null;
  duration = v3Result?.duration || turboResult?.duration || 0;

  console.log(`[DualWhisper] ${segmentKey}: v3="${v3Text?.slice(0, 50)}...", turbo="${turboText?.slice(0, 50)}..."`);

  // Handle cases where one or both failed
  if (!v3Text && !turboText) {
    console.error(`[DualWhisper] ${segmentKey}: Both models returned empty`);
    return {
      finalText: '',
      confidence: 'very-low',
      method: 'single-fallback',
      v3Text: null,
      turboText: null,
      agreementScore: 0,
      duration,
      issues: ['Both Whisper models failed'],
      wordCount: 0,
      avgLogprob: -1,
      noSpeechProb: 0,
      avgConfidence: 0,
      fillerWords: [],
      longPauses: [],
    };
  }

  if (!v3Text || v3Text.length < 3) {
    console.log(`[DualWhisper] ${segmentKey}: v3 failed, using turbo`);
    issues.push('v3 model failed, using turbo only');
    const wordCount = turboText?.split(/\s+/).filter(w => w.length > 0).length || 0;
    const meta = extractWhisperMeta(turboResult);
    return {
      finalText: turboText || '',
      confidence: 'low',
      method: 'single-fallback',
      v3Text: null,
      turboText,
      agreementScore: 0,
      duration,
      issues,
      wordCount,
      avgLogprob: meta.avgLogprob,
      noSpeechProb: meta.noSpeechProb,
      avgConfidence: Math.max(0, Math.min(1, meta.avgLogprob + 1)),
      fillerWords: extractFillerWords(turboText || ''),
      longPauses: meta.longPauses,
    };
  }

  if (!turboText || turboText.length < 3) {
    console.log(`[DualWhisper] ${segmentKey}: turbo failed, using v3`);
    issues.push('turbo model failed, using v3 only');
    const wordCount = v3Text.split(/\s+/).filter(w => w.length > 0).length;
    const meta = extractWhisperMeta(v3Result);
    return {
      finalText: v3Text,
      confidence: 'low',
      method: 'single-fallback',
      v3Text,
      turboText: null,
      agreementScore: 0,
      duration,
      issues,
      wordCount,
      avgLogprob: meta.avgLogprob,
      noSpeechProb: meta.noSpeechProb,
      avgConfidence: Math.max(0, Math.min(1, meta.avgLogprob + 1)),
      fillerWords: extractFillerWords(v3Text),
      longPauses: meta.longPauses,
    };
  }

  // Check for hallucinations in each
  const v3Hallucinations = detectHallucinations(v3Text);
  const turboHallucinations = detectHallucinations(turboText);

  if (v3Hallucinations.length > 0) {
    issues.push(`v3 hallucinations: ${v3Hallucinations.join(', ')}`);
  }
  if (turboHallucinations.length > 0) {
    issues.push(`turbo hallucinations: ${turboHallucinations.join(', ')}`);
  }

  // Word count validation
  const v3WordValidation = validateWordCount(v3Text, duration);
  const turboWordValidation = validateWordCount(turboText, duration);

  if (!v3WordValidation.isValid) {
    issues.push(`v3: ${v3WordValidation.issue}`);
  }
  if (!turboWordValidation.isValid) {
    issues.push(`turbo: ${turboWordValidation.issue}`);
  }

  // Calculate agreement
  const agreementScore = calculateAgreement(v3Text, turboText);
  console.log(`[DualWhisper] ${segmentKey}: Agreement score: ${(agreementScore * 100).toFixed(1)}%`);

  // Check completeness offset - detect if one model skipped the beginning
  const moreComplete = checkCompletenessOffset(v3Text, turboText);
  if (moreComplete) {
    issues.push(`${moreComplete} is more complete (other may have skipped beginning)`);
  }

  // Decision logic
  let finalText: string;
  let confidence: 'high' | 'medium' | 'low' | 'very-low';
  let method: DualWhisperResult['method'];

  // If one transcript is clearly more complete, prefer it
  if (moreComplete && agreementScore < 0.8) {
    finalText = moreComplete === 'v3' ? v3Text : turboText;
    method = moreComplete === 'v3' ? 'v3-selected' : 'turbo-selected';
    confidence = 'medium';
    console.log(`[DualWhisper] ${segmentKey}: Selected ${moreComplete} as MORE COMPLETE transcript`);
  }
  // HIGH AGREEMENT (>80%): Use consensus
  else if (agreementScore >= 0.8) {
    // Texts are very similar - prefer turbo (fewer hallucinations) if lengths are similar
    finalText = turboText.length >= v3Text.length * 0.9 ? turboText : v3Text;
    confidence = 'high';
    method = 'consensus';
    console.log(`[DualWhisper] ${segmentKey}: HIGH consensus (${(agreementScore * 100).toFixed(1)}%)`);
  }
  // MEDIUM AGREEMENT (50-80%): Evaluate quality
  else if (agreementScore >= 0.5) {
    // Prefer the one with fewer issues
    const v3Score = (v3Hallucinations.length === 0 ? 1 : 0) + (v3WordValidation.isValid ? 1 : 0);
    const turboScore = (turboHallucinations.length === 0 ? 1 : 0) + (turboWordValidation.isValid ? 1 : 0);

    if (turboScore > v3Score) {
      finalText = turboText;
      method = 'turbo-selected';
    } else if (v3Score > turboScore) {
      finalText = v3Text;
      method = 'v3-selected';
    } else {
      // Equal scores - prefer turbo for noise robustness
      finalText = turboText;
      method = 'turbo-selected';
    }
    confidence = 'medium';
    console.log(`[DualWhisper] ${segmentKey}: MEDIUM agreement, selected ${method}`);
  }
  // LOW AGREEMENT (<50%): One is likely wrong
  else {
    // Major disagreement - check which one is more valid
    const v3Valid = v3Hallucinations.length === 0 && v3WordValidation.isValid;
    const turboValid = turboHallucinations.length === 0 && turboWordValidation.isValid;

    if (turboValid && !v3Valid) {
      finalText = turboText;
      method = 'turbo-selected';
    } else if (v3Valid && !turboValid) {
      finalText = v3Text;
      method = 'v3-selected';
    } else {
      // Neither is clearly better. Prefer the one with fewer immediate repeats.
      const v3Repeats = countImmediateRepeats(v3Text);
      const turboRepeats = countImmediateRepeats(turboText);

      if (v3Repeats !== turboRepeats) {
        finalText = v3Repeats < turboRepeats ? v3Text : turboText;
        method = v3Repeats < turboRepeats ? 'v3-selected' : 'turbo-selected';
        issues.push('Low agreement, used fewer-repeat transcript');
      } else {
        // Fall back to transcript with higher word count (less likely to have dropped clauses)
        finalText = v3Text.length >= turboText.length ? v3Text : turboText;
        method = v3Text.length >= turboText.length ? 'v3-selected' : 'turbo-selected';
        issues.push('Low agreement, used longer transcript');
      }
    }
    confidence = 'low';
    console.log(`[DualWhisper] ${segmentKey}: LOW agreement (${(agreementScore * 100).toFixed(1)}%), selected ${method}`);
  }

  const wordCount = finalText.split(/\s+/).filter(w => w.length > 0).length;

  // Prefer v3 metadata when available (turbo is currently unstable for some segments)
  const meta = extractWhisperMeta(v3Result || turboResult);

  return {
    finalText,
    confidence,
    method,
    v3Text,
    turboText,
    agreementScore,
    duration,
    issues,
    wordCount,
    avgLogprob: meta.avgLogprob,
    noSpeechProb: meta.noSpeechProb,
    avgConfidence: Math.max(0, Math.min(1, meta.avgLogprob + 1)),
    fillerWords: extractFillerWords(finalText),
    longPauses: meta.longPauses,
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

    // Get TWO Groq API keys: one for V3, one for Turbo
    console.log(`[groq-speaking-transcribe] Checking out API keys for V3 and Turbo...`);
    
    const [v3KeyResult, turboKeyResult] = await Promise.all([
      supabaseService.rpc('checkout_groq_key_for_stt', {
        p_job_id: String(jobId),
        p_lock_duration_seconds: 600,
        p_part_number: 1, // V3 key
      }),
      supabaseService.rpc('checkout_groq_key_for_stt', {
        p_job_id: String(jobId),
        p_lock_duration_seconds: 600,
        p_part_number: 2, // Turbo key
      }),
    ]);

    if (v3KeyResult.error || !v3KeyResult.data || v3KeyResult.data.length === 0) {
      console.error(`[groq-speaking-transcribe] No Groq keys available for V3:`, v3KeyResult.error);
      throw new Error('No Groq API keys available for V3 STT');
    }

    const v3Key = v3KeyResult.data[0];
    const v3ApiKey = v3Key.out_key_value;
    const v3KeyId = v3Key.out_key_id;

    // Turbo key may be same as V3 if only one key available
    let turboApiKey = v3ApiKey;
    let turboKeyId = v3KeyId;
    
    if (!turboKeyResult.error && turboKeyResult.data && turboKeyResult.data.length > 0) {
      turboApiKey = turboKeyResult.data[0].out_key_value;
      turboKeyId = turboKeyResult.data[0].out_key_id;
    }

    const sameKey = v3KeyId === turboKeyId;
    console.log(`[groq-speaking-transcribe] Using V3 key ${v3KeyId?.slice(0, 8)}..., Turbo key ${turboKeyId?.slice(0, 8)}... (same=${sameKey})`);

    await supabaseService
      .from('speaking_evaluation_jobs')
      .update({ groq_stt_key_id: v3KeyId })
      .eq('id', jobId);

    // Process segments
    const filePaths = job.file_paths as Record<string, string>;
    const segments = Object.entries(filePaths);
    const transcriptions: SegmentTranscription[] = [];
    let totalAudioSecondsV3 = 0;
    let totalAudioSecondsTurbo = 0;

    let turboFailuresInJob = 0;

    console.log(`[groq-speaking-transcribe] Processing ${segments.length} segments with Dual-Whisper engine`);

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

        // Run Dual-Whisper transcription with separate keys
        const disableTurbo = turboFailuresInJob >= TURBO_FAILURE_DISABLE_THRESHOLD;
        const result = await dualWhisperTranscribe(audioBlob, v3ApiKey, turboApiKey, segmentKey, { disableTurbo });

        // Track Turbo failures so we can stop calling it within this job.
        if (!disableTurbo && result.method === 'single-fallback' && (result.issues || []).some(i => i.includes('turbo model failed'))) {
          turboFailuresInJob++;
          console.warn(`[groq-speaking-transcribe] Turbo failures in job so far: ${turboFailuresInJob}`);
        }

        // Track audio seconds for each model separately
        if (result.v3Text) totalAudioSecondsV3 += result.duration;
        if (result.turboText && !disableTurbo) totalAudioSecondsTurbo += result.duration;

        transcriptions.push({
          segmentKey,
          partNumber,
          questionNumber,
          text: result.finalText,
          duration: result.duration,
          wordCount: result.wordCount,
          avgConfidence: result.avgConfidence,
          avgLogprob: result.avgLogprob,
          fillerWords: result.fillerWords,
          longPauses: result.longPauses,
          noSpeechProb: result.noSpeechProb,
          confidence: result.confidence,
          method: result.method,
          agreementScore: result.agreementScore,
          issues: result.issues,
        });

        console.log(`[groq-speaking-transcribe] ${segmentKey}: ${result.wordCount} words, ${result.confidence} confidence, method=${result.method}`);

      } catch (segmentError: any) {
        console.error(`[groq-speaking-transcribe] Segment ${segmentKey} error:`, segmentError.message);

        if (segmentError instanceof WhisperHTTPError && segmentError.status === 429) {
          console.error(`[groq-speaking-transcribe] Rate limit hit on segment ${segmentKey}`);
          await supabaseService.rpc('mark_groq_key_rpm_limited', {
            p_key_id: v3KeyId,
            p_cooldown_seconds: 60,
          });
          throw new Error('RATE_LIMIT: Groq RPM limit hit');
        }

        if (segmentError.message?.includes('429') || segmentError.message?.includes('rate limit')) {
          await supabaseService.rpc('mark_groq_key_rpm_limited', {
            p_key_id: v3KeyId,
            p_cooldown_seconds: 60,
          });
          throw new Error('RATE_LIMIT: Groq RPM limit hit');
        }
      }
    }

    // Record ASH usage separately for each key
    if (totalAudioSecondsV3 > 0) {
      await supabaseService.rpc('record_groq_ash_usage', {
        p_key_id: v3KeyId,
        p_audio_seconds: Math.ceil(totalAudioSecondsV3),
      });
      console.log(`[groq-speaking-transcribe] Recorded ${Math.ceil(totalAudioSecondsV3)}s ASH usage for V3 key`);
    }
    
    if (totalAudioSecondsTurbo > 0 && !sameKey) {
      await supabaseService.rpc('record_groq_ash_usage', {
        p_key_id: turboKeyId,
        p_audio_seconds: Math.ceil(totalAudioSecondsTurbo),
      });
      console.log(`[groq-speaking-transcribe] Recorded ${Math.ceil(totalAudioSecondsTurbo)}s ASH usage for Turbo key`);
    } else if (totalAudioSecondsTurbo > 0 && sameKey) {
      // Same key - add to total
      await supabaseService.rpc('record_groq_ash_usage', {
        p_key_id: v3KeyId,
        p_audio_seconds: Math.ceil(totalAudioSecondsTurbo),
      });
      console.log(`[groq-speaking-transcribe] Recorded additional ${Math.ceil(totalAudioSecondsTurbo)}s ASH usage for Turbo (same key)`);
    }

    // Store results
    const transcriptionResult = {
      transcriptions,
      totalAudioSeconds: totalAudioSecondsV3 + totalAudioSecondsTurbo,
      segmentCount: transcriptions.length,
      pipelineVersion: 'dual-whisper-2.1',
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

    console.log(`[groq-speaking-transcribe] Transcription complete. ${transcriptions.length} segments, ${(totalAudioSecondsV3 + totalAudioSecondsTurbo).toFixed(1)}s audio`);

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
      totalAudioSeconds: totalAudioSecondsV3 + totalAudioSecondsTurbo,
      pipelineVersion: 'dual-whisper-2.1',
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
