import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { 
  RefreshCw, 
  CheckCircle,
  XCircle,
  AlertTriangle,
  Zap,
  Brain,
  MessageSquare,
  PenTool,
  Mic,
  Volume2
} from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface ApiKeyWithQuotas {
  id: string;
  key_value: string;
  is_active: boolean;
  created_at: string;
  tts_quota_exhausted: boolean | null;
  tts_quota_exhausted_date: string | null;
  flash_2_5_quota_exhausted: boolean | null;
  flash_2_5_quota_exhausted_date: string | null;
  flash_lite_quota_exhausted: boolean | null;
  flash_lite_quota_exhausted_date: string | null;
  pro_3_0_quota_exhausted: boolean | null;
  pro_3_0_quota_exhausted_date: string | null;
  exp_pro_quota_exhausted: boolean | null;
  exp_pro_quota_exhausted_date: string | null;
}

type QuotaType = 'tts' | 'flash_2_5' | 'flash_lite' | 'pro_3_0' | 'exp_pro';

interface QuotaCategory {
  id: QuotaType;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  models: string[];
}

const QUOTA_CATEGORIES: QuotaCategory[] = [
  {
    id: 'exp_pro',
    label: 'Architect',
    description: 'Test Generation (gemini-exp-1206)',
    icon: Brain,
    color: 'text-purple-500',
    models: ['gemini-exp-1206', 'gemini-2.0-flash-exp'],
  },
  {
    id: 'flash_lite',
    label: 'Tutor',
    description: 'Explanations (gemini-2.0-flash-lite)',
    icon: MessageSquare,
    color: 'text-blue-500',
    models: ['gemini-2.0-flash-lite-preview-02-05', 'gemini-2.0-flash-lite'],
  },
  {
    id: 'pro_3_0',
    label: 'Critic',
    description: 'Writing Evaluation (gemini-3-pro)',
    icon: PenTool,
    color: 'text-emerald-500',
    models: ['gemini-3-pro-preview', 'gemini-2.5-pro'],
  },
  {
    id: 'flash_2_5',
    label: 'Listener',
    description: 'Speaking Evaluation (gemini-2.0-flash)',
    icon: Mic,
    color: 'text-orange-500',
    models: ['gemini-2.0-flash', 'gemini-2.5-flash'],
  },
  {
    id: 'tts',
    label: 'Voice',
    description: 'Text-to-Speech Audio',
    icon: Volume2,
    color: 'text-rose-500',
    models: ['TTS models'],
  },
];

export default function ApiKeyQuotaDashboard() {
  const [apiKeys, setApiKeys] = useState<ApiKeyWithQuotas[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    fetchApiKeys();
  }, []);

  const fetchApiKeys = async () => {
    try {
      const { data, error } = await supabase
        .from('api_keys')
        .select('*')
        .eq('provider', 'gemini')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setApiKeys(data || []);
    } catch (error) {
      console.error('Error fetching API keys:', error);
      toast({
        title: 'Error',
        description: 'Failed to load API keys',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const refreshData = async () => {
    setRefreshing(true);
    await fetchApiKeys();
    setRefreshing(false);
  };

  const maskKey = (key: string) => {
    if (key.length <= 8) return '••••••••';
    return key.substring(0, 4) + '••••' + key.substring(key.length - 4);
  };

  const isQuotaExhaustedToday = (date: string | null) => {
    if (!date) return false;
    const today = new Date().toISOString().split('T')[0];
    return date === today;
  };

  const getQuotaStatus = (key: ApiKeyWithQuotas, quotaType: QuotaType) => {
    const exhaustedField = `${quotaType}_quota_exhausted` as keyof ApiKeyWithQuotas;
    const dateField = `${quotaType}_quota_exhausted_date` as keyof ApiKeyWithQuotas;
    
    const isExhausted = key[exhaustedField] as boolean | null;
    const exhaustedDate = key[dateField] as string | null;
    
    return isExhausted && isQuotaExhaustedToday(exhaustedDate);
  };

  const toggleQuota = async (keyId: string, quotaType: QuotaType, currentlyExhausted: boolean) => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const updateData: Record<string, unknown> = {
        [`${quotaType}_quota_exhausted`]: !currentlyExhausted,
        [`${quotaType}_quota_exhausted_date`]: !currentlyExhausted ? today : null,
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabase
        .from('api_keys')
        .update(updateData)
        .eq('id', keyId);

      if (error) throw error;

      setApiKeys(prev =>
        prev.map(key =>
          key.id === keyId
            ? {
                ...key,
                [`${quotaType}_quota_exhausted`]: !currentlyExhausted,
                [`${quotaType}_quota_exhausted_date`]: !currentlyExhausted ? today : null,
              }
            : key
        ) as ApiKeyWithQuotas[]
      );

      toast({
        title: 'Success',
        description: `${quotaType.replace(/_/g, ' ').toUpperCase()} quota ${!currentlyExhausted ? 'disabled' : 'enabled'} for this key`,
      });
    } catch (error) {
      console.error('Error toggling quota:', error);
      toast({
        title: 'Error',
        description: 'Failed to update quota status',
        variant: 'destructive',
      });
    }
  };

  const resetAllQuotasForType = async (quotaType: QuotaType) => {
    try {
      const updateData: Record<string, unknown> = {
        [`${quotaType}_quota_exhausted`]: false,
        [`${quotaType}_quota_exhausted_date`]: null,
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabase
        .from('api_keys')
        .update(updateData)
        .eq('provider', 'gemini');

      if (error) throw error;

      setApiKeys(prev =>
        prev.map(key => ({
          ...key,
          [`${quotaType}_quota_exhausted`]: false,
          [`${quotaType}_quota_exhausted_date`]: null,
        })) as ApiKeyWithQuotas[]
      );

      toast({
        title: 'Success',
        description: `All ${quotaType.replace(/_/g, ' ')} quotas reset`,
      });
    } catch (error) {
      console.error('Error resetting quotas:', error);
      toast({
        title: 'Error',
        description: 'Failed to reset quotas',
        variant: 'destructive',
      });
    }
  };

  const getQuotaSummary = (quotaType: QuotaType) => {
    const activeKeys = apiKeys.filter(k => k.is_active);
    const exhaustedKeys = activeKeys.filter(k => getQuotaStatus(k, quotaType));
    return {
      total: activeKeys.length,
      available: activeKeys.length - exhaustedKeys.length,
      exhausted: exhaustedKeys.length,
    };
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Quota Overview Cards */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Model Quota Status</h2>
        <Button variant="outline" size="sm" onClick={refreshData} disabled={refreshing}>
          <RefreshCw className={`w-4 h-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        {QUOTA_CATEGORIES.map((category) => {
          const summary = getQuotaSummary(category.id);
          const Icon = category.icon;
          const isHealthy = summary.available > 0;
          
          return (
            <Card key={category.id} className={`relative overflow-hidden ${!isHealthy ? 'border-destructive/50' : ''}`}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <Icon className={`w-5 h-5 ${category.color}`} />
                  {summary.exhausted > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => resetAllQuotasForType(category.id)}
                    >
                      Reset All
                    </Button>
                  )}
                </div>
                <CardTitle className="text-sm font-medium">{category.label}</CardTitle>
                <CardDescription className="text-xs">{category.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <div className="text-2xl font-bold">
                    {summary.available}/{summary.total}
                  </div>
                  {isHealthy ? (
                    <Badge variant="outline" className="text-green-600 border-green-600">
                      <CheckCircle className="w-3 h-3 mr-1" />
                      OK
                    </Badge>
                  ) : (
                    <Badge variant="destructive">
                      <XCircle className="w-3 h-3 mr-1" />
                      Exhausted
                    </Badge>
                  )}
                </div>
                {summary.exhausted > 0 && (
                  <p className="text-xs text-muted-foreground mt-2">
                    {summary.exhausted} key{summary.exhausted > 1 ? 's' : ''} at limit
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Detailed Quota Matrix */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-primary" />
            API Key Quota Matrix
          </CardTitle>
          <CardDescription>
            Toggle switches to manually disable models for specific API keys. Disabled models won't be attempted for that key today.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[150px]">API Key</TableHead>
                  <TableHead className="text-center">Status</TableHead>
                  {QUOTA_CATEGORIES.map((category) => (
                    <TableHead key={category.id} className="text-center">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="flex flex-col items-center gap-1 cursor-help">
                            <category.icon className={`w-4 h-4 ${category.color}`} />
                            <span className="text-xs">{category.label}</span>
                          </div>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="font-medium">{category.description}</p>
                          <p className="text-xs text-muted-foreground mt-1">
                            Models: {category.models.join(', ')}
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {apiKeys.map((key) => (
                  <TableRow key={key.id} className={!key.is_active ? 'opacity-50' : ''}>
                    <TableCell className="font-mono text-sm">
                      {maskKey(key.key_value)}
                    </TableCell>
                    <TableCell className="text-center">
                      {key.is_active ? (
                        <Badge variant="outline" className="text-green-600 border-green-600">
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground">
                          Disabled
                        </Badge>
                      )}
                    </TableCell>
                    {QUOTA_CATEGORIES.map((category) => {
                      const isExhausted = getQuotaStatus(key, category.id);
                      return (
                        <TableCell key={category.id} className="text-center">
                          <div className="flex items-center justify-center gap-2">
                            <Switch
                              checked={!isExhausted}
                              onCheckedChange={() => toggleQuota(key.id, category.id, isExhausted ?? false)}
                              disabled={!key.is_active}
                            />
                            {isExhausted ? (
                              <AlertTriangle className="w-4 h-4 text-amber-500" />
                            ) : (
                              <CheckCircle className="w-4 h-4 text-green-500" />
                            )}
                          </div>
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
