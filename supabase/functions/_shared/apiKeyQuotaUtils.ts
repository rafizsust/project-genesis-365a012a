// Shared utility for API key quota management
// Per-Model Quota Tracking - Each specific model is tracked independently

// All Gemini models used across the application
export type GeminiModelType = 
  | 'gemini-2.0-flash'
  | 'gemini-2.0-flash-lite'
  | 'gemini-2.0-flash-lite-preview-02-05'
  | 'gemini-2.5-flash'
  | 'gemini-2.5-flash-preview-tts'
  | 'gemini-2.5-pro'
  | 'gemini-3-pro-preview'
  | 'gemini-exp-1206';

// Legacy bucket types for backward compatibility
export type QuotaModelType = 
  | 'tts'           // Text-to-speech generation
  | 'flash_2_5'     // Standard flash models (gemini-2.5-flash, gemini-2.0-flash)
  | 'flash_lite'    // Speed-optimized lite models (gemini-2.0-flash-lite, tutor/explainer)
  | 'pro_3_0'       // Deep reasoning models (gemini-3-pro-preview, writing evaluation)
  | 'exp_pro';      // Experimental pro models (gemini-exp-1206, test generation)

// Mapping from actual model name to database column prefix
const MODEL_TO_DB_COLUMN: Record<string, string> = {
  'gemini-2.0-flash': 'gemini_2_0_flash',
  'gemini-2.0-flash-lite': 'gemini_2_0_flash_lite',
  'gemini-2.0-flash-lite-preview-02-05': 'gemini_2_0_flash_lite', // Maps to same column
  'gemini-2.5-flash': 'gemini_2_5_flash',
  'gemini-2.5-flash-preview-tts': 'gemini_2_5_flash_tts',
  'gemini-2.5-pro': 'gemini_2_5_pro',
  'gemini-3-pro-preview': 'gemini_3_pro',
  'gemini-exp-1206': 'gemini_exp_1206',
};

// All model columns for full SELECT
export const ALL_MODEL_QUOTA_COLUMNS = [
  // Legacy bucket columns
  'tts_quota_exhausted', 'tts_quota_exhausted_date',
  'flash_2_5_quota_exhausted', 'flash_2_5_quota_exhausted_date',
  'flash_lite_quota_exhausted', 'flash_lite_quota_exhausted_date',
  'pro_3_0_quota_exhausted', 'pro_3_0_quota_exhausted_date',
  'exp_pro_quota_exhausted', 'exp_pro_quota_exhausted_date',
  // New per-model columns
  'gemini_2_0_flash_exhausted', 'gemini_2_0_flash_exhausted_date',
  'gemini_2_0_flash_lite_exhausted', 'gemini_2_0_flash_lite_exhausted_date',
  'gemini_2_5_flash_exhausted', 'gemini_2_5_flash_exhausted_date',
  'gemini_2_5_flash_tts_exhausted', 'gemini_2_5_flash_tts_exhausted_date',
  'gemini_2_5_pro_exhausted', 'gemini_2_5_pro_exhausted_date',
  'gemini_3_pro_exhausted', 'gemini_3_pro_exhausted_date',
  'gemini_exp_1206_exhausted', 'gemini_exp_1206_exhausted_date',
];

interface ApiKeyRecord {
  id: string;
  provider: string;
  key_value: string;
  is_active: boolean;
  error_count: number;
  // Legacy bucket quotas
  tts_quota_exhausted?: boolean;
  tts_quota_exhausted_date?: string;
  flash_2_5_quota_exhausted?: boolean;
  flash_2_5_quota_exhausted_date?: string;
  flash_lite_quota_exhausted?: boolean;
  flash_lite_quota_exhausted_date?: string;
  pro_3_0_quota_exhausted?: boolean;
  pro_3_0_quota_exhausted_date?: string;
  exp_pro_quota_exhausted?: boolean;
  exp_pro_quota_exhausted_date?: string;
  // New per-model quotas
  gemini_2_0_flash_exhausted?: boolean;
  gemini_2_0_flash_exhausted_date?: string;
  gemini_2_0_flash_lite_exhausted?: boolean;
  gemini_2_0_flash_lite_exhausted_date?: string;
  gemini_2_5_flash_exhausted?: boolean;
  gemini_2_5_flash_exhausted_date?: string;
  gemini_2_5_flash_tts_exhausted?: boolean;
  gemini_2_5_flash_tts_exhausted_date?: string;
  gemini_2_5_pro_exhausted?: boolean;
  gemini_2_5_pro_exhausted_date?: string;
  gemini_3_pro_exhausted?: boolean;
  gemini_3_pro_exhausted_date?: string;
  gemini_exp_1206_exhausted?: boolean;
  gemini_exp_1206_exhausted_date?: string;
}

// Get today's date in YYYY-MM-DD format
export function getTodayDate(): string {
  return new Date().toISOString().split('T')[0];
}

// Check if a quota exhaustion is still valid (same day)
export function isQuotaExhaustedToday(exhaustedDate: string | null | undefined): boolean {
  if (!exhaustedDate) return false;
  return exhaustedDate === getTodayDate();
}

// Get the database column names for a specific model
export function getModelQuotaFieldNames(modelName: string): { quotaField: string; quotaDateField: string } {
  const columnPrefix = MODEL_TO_DB_COLUMN[modelName];
  if (columnPrefix) {
    return {
      quotaField: `${columnPrefix}_exhausted`,
      quotaDateField: `${columnPrefix}_exhausted_date`
    };
  }
  // Fallback to legacy flash_2_5 bucket for unknown models
  return { quotaField: 'flash_2_5_quota_exhausted', quotaDateField: 'flash_2_5_quota_exhausted_date' };
}

// Legacy: Get the quota field names for a given bucket type
function getQuotaFieldNames(modelType: QuotaModelType): { quotaField: string; quotaDateField: string } {
  switch (modelType) {
    case 'tts':
      return { quotaField: 'tts_quota_exhausted', quotaDateField: 'tts_quota_exhausted_date' };
    case 'flash_lite':
      return { quotaField: 'flash_lite_quota_exhausted', quotaDateField: 'flash_lite_quota_exhausted_date' };
    case 'pro_3_0':
      return { quotaField: 'pro_3_0_quota_exhausted', quotaDateField: 'pro_3_0_quota_exhausted_date' };
    case 'exp_pro':
      return { quotaField: 'exp_pro_quota_exhausted', quotaDateField: 'exp_pro_quota_exhausted_date' };
    case 'flash_2_5':
    default:
      return { quotaField: 'flash_2_5_quota_exhausted', quotaDateField: 'flash_2_5_quota_exhausted_date' };
  }
}

// Check if a specific model is exhausted for a key
export function isModelExhaustedForKey(key: ApiKeyRecord, modelName: string): boolean {
  const today = getTodayDate();
  const { quotaField, quotaDateField } = getModelQuotaFieldNames(modelName);
  const isExhausted = (key as any)[quotaField];
  const exhaustedDate = (key as any)[quotaDateField];
  return isExhausted === true && exhaustedDate === today;
}

// Fetch active Gemini keys that are not quota-exhausted for ANY of the specified models
export async function getActiveGeminiKeysForModels(
  supabaseServiceClient: any,
  modelNames: string[]
): Promise<ApiKeyRecord[]> {
  try {
    const today = getTodayDate();
    
    // First, reset any quotas from previous days
    await supabaseServiceClient.rpc('reset_api_key_model_quotas');
    
    // Build select columns
    const selectColumns = `id, provider, key_value, is_active, error_count, ${ALL_MODEL_QUOTA_COLUMNS.join(', ')}`;
    
    // Fetch all active keys
    const { data, error } = await supabaseServiceClient
      .from('api_keys')
      .select(selectColumns)
      .eq('provider', 'gemini')
      .eq('is_active', true)
      .order('error_count', { ascending: true });
    
    if (error) {
      console.error('Failed to fetch API keys:', error);
      return [];
    }
    
    // Filter keys that have at least one of the requested models available
    const availableKeys = (data || []).filter((key: ApiKeyRecord) => {
      return modelNames.some(modelName => !isModelExhaustedForKey(key, modelName));
    });
    
    console.log(`Found ${availableKeys.length} active Gemini keys with available models from [${modelNames.join(', ')}]`);
    return availableKeys;
  } catch (err) {
    console.error('Error fetching API keys:', err);
    return [];
  }
}

// Legacy: Fetch active Gemini keys that are not quota-exhausted for the specified model type
export async function getActiveGeminiKeysForModel(
  supabaseServiceClient: any,
  modelType: QuotaModelType
): Promise<ApiKeyRecord[]> {
  try {
    const today = getTodayDate();
    const { quotaField, quotaDateField } = getQuotaFieldNames(modelType);
    
    // First, reset any quotas from previous days
    await supabaseServiceClient.rpc('reset_api_key_quotas');
    
    // Fetch keys that are active and not quota-exhausted for today
    const { data, error } = await supabaseServiceClient
      .from('api_keys')
      .select(`id, provider, key_value, is_active, error_count, ${ALL_MODEL_QUOTA_COLUMNS.join(', ')}`)
      .eq('provider', 'gemini')
      .eq('is_active', true)
      .or(`${quotaField}.is.null,${quotaField}.eq.false,${quotaDateField}.lt.${today}`)
      .order('error_count', { ascending: true });
    
    if (error) {
      console.error('Failed to fetch API keys:', error);
      return [];
    }
    
    console.log(`Found ${data?.length || 0} active Gemini keys available for ${modelType} model`);
    return data || [];
  } catch (err) {
    console.error('Error fetching API keys:', err);
    return [];
  }
}

// Mark a key as having exhausted its quota for a specific model
export async function markModelQuotaExhausted(
  supabaseServiceClient: any,
  keyId: string,
  modelName: string
): Promise<void> {
  try {
    const today = getTodayDate();
    const { quotaField, quotaDateField } = getModelQuotaFieldNames(modelName);
    
    const updateData: Record<string, any> = {
      [quotaField]: true,
      [quotaDateField]: today,
      updated_at: new Date().toISOString()
    };
    
    await supabaseServiceClient
      .from('api_keys')
      .update(updateData)
      .eq('id', keyId);
    
    console.log(`Marked key ${keyId} as ${modelName} quota exhausted for ${today}`);
  } catch (err) {
    console.error(`Failed to mark model quota exhausted:`, err);
  }
}

// Legacy: Mark a key as having exhausted its quota for a specific model type bucket
export async function markKeyQuotaExhausted(
  supabaseServiceClient: any,
  keyId: string,
  modelType: QuotaModelType
): Promise<void> {
  try {
    const today = getTodayDate();
    const { quotaField, quotaDateField } = getQuotaFieldNames(modelType);
    
    const updateData: Record<string, any> = {
      [quotaField]: true,
      [quotaDateField]: today,
      updated_at: new Date().toISOString()
    };
    
    await supabaseServiceClient
      .from('api_keys')
      .update(updateData)
      .eq('id', keyId);
    
    console.log(`Marked key ${keyId} as ${modelType} quota exhausted for ${today}`);
  } catch (err) {
    console.error(`Failed to mark key quota exhausted:`, err);
  }
}
// Check if an error indicates *daily quota exhaustion* (NOT per-minute rate limiting)
// This is a LOOSE check - returns true for any quota-related messaging
export function isQuotaExhaustedError(error: any): boolean {
  if (!error) return false;

  const errorMessage = typeof error === 'string'
    ? error
    : (error.message || error.error?.message || '');
  const errorStatus = error.status || error.error?.status || '';

  const msg = String(errorMessage).toLowerCase();

  // IMPORTANT:
  // - 429 "Too Many Requests" is often an RPM/RPS rate limit and should NOT be treated as "daily quota exhausted".
  // - Only treat explicit "quota" / "resource exhausted" style signals as quota exhaustion.
  return (
    errorStatus === 'RESOURCE_EXHAUSTED' ||
    msg.includes('resource_exhausted') ||
    msg.includes('resource exhausted') ||
    msg.includes('quota') ||
    msg.includes('exceeded') && msg.includes('quota') ||
    msg.includes('check your plan') ||
    msg.includes('billing')
  );
}

/**
 * STRICT check for PERMANENT daily quota exhaustion
 * Use this ONLY when deciding to mark a model as exhausted for the day.
 * This should NOT return true for:
 * - 429 rate limits (RPM/TPM)
 * - Temporary resource exhaustion
 * - Server errors
 * 
 * This SHOULD return true for:
 * - Daily quota limit reached (billing/plan related)
 * - Account-level restrictions
 */
export function isDailyQuotaExhaustedError(error: any): boolean {
  if (!error) return false;

  const errorMessage = typeof error === 'string'
    ? error
    : (error.message || error.error?.message || '');
  
  const msg = String(errorMessage).toLowerCase();

  // ONLY mark as daily exhausted for clear billing/quota signals
  // These indicate the key has truly hit its daily limit
  if (msg.includes('check your plan')) return true;
  if (msg.includes('billing')) return true;
  if (msg.includes('limit: 0')) return true;
  if (msg.includes('per day') && !msg.includes('retry')) return true;
  if (msg.includes('daily quota') || msg.includes('daily limit')) return true;
  if (msg.includes('quota exceeded') && (msg.includes('per day') || msg.includes('daily'))) return true;
  
  // Check for API response indicating permanent quota exhaustion
  // Gemini returns specific error codes for daily quota vs rate limits
  if (msg.includes('exhausted') && msg.includes('quota')) {
    // Make sure it's not just a per-minute rate limit message
    if (!msg.includes('per minute') && !msg.includes('rpm') && !msg.includes('tpm')) {
      return true;
    }
  }
  
  return false;
}

// Reset quota exhaustion for a specific model on a key
export async function resetModelQuota(
  supabaseServiceClient: any,
  keyId: string,
  modelName: string
): Promise<void> {
  try {
    const { quotaField, quotaDateField } = getModelQuotaFieldNames(modelName);
    
    const updateData: Record<string, any> = {
      [quotaField]: false,
      [quotaDateField]: null,
      updated_at: new Date().toISOString()
    };
    
    await supabaseServiceClient
      .from('api_keys')
      .update(updateData)
      .eq('id', keyId);
    
    console.log(`Reset ${modelName} quota for key ${keyId}`);
  } catch (err) {
    console.error('Failed to reset model quota:', err);
  }
}

// Legacy: Reset quota exhaustion for a key (admin action)
export async function resetKeyQuota(
  supabaseServiceClient: any,
  keyId: string,
  modelType?: QuotaModelType
): Promise<void> {
  try {
    const updateData: any = { updated_at: new Date().toISOString() };
    
    // Reset all quota types if no specific type is provided
    const typesToReset: QuotaModelType[] = modelType 
      ? [modelType] 
      : ['tts', 'flash_2_5', 'flash_lite', 'pro_3_0', 'exp_pro'];
    
    for (const type of typesToReset) {
      const { quotaField, quotaDateField } = getQuotaFieldNames(type);
      updateData[quotaField] = false;
      updateData[quotaDateField] = null;
    }
    
    await supabaseServiceClient
      .from('api_keys')
      .update(updateData)
      .eq('id', keyId);
    
    console.log(`Reset ${modelType || 'all'} quota for key ${keyId}`);
  } catch (err) {
    console.error('Failed to reset key quota:', err);
  }
}
