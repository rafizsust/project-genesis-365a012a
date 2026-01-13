import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { 
  Key, 
  Plus, 
  Trash2, 
  RefreshCw, 
  CheckCircle,
  Eye,
  EyeOff,
  Loader2
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

interface UserApiKey {
  id: string;
  provider: string;
  key_value: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  tts_quota_exhausted: boolean | null;
  tts_quota_exhausted_date: string | null;
  flash_2_5_quota_exhausted: boolean | null;
  flash_2_5_quota_exhausted_date: string | null;
}

interface UserApiKeyManagerProps {
  onApiKeyChanged?: () => void;
}

export function UserApiKeyManager({ onApiKeyChanged }: UserApiKeyManagerProps) {
  const { user } = useAuth();
  const [apiKeys, setApiKeys] = useState<UserApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKeyValue, setNewKeyValue] = useState('');
  const [showNewKey, setShowNewKey] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (user) {
      fetchApiKeys();
    }
  }, [user]);

  const fetchApiKeys = async () => {
    if (!user) return;
    
    try {
      const { data, error } = await supabase
        .from('user_api_keys')
        .select('*')
        .eq('user_id', user.id)
        .eq('provider', 'gemini')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setApiKeys(data || []);
    } catch (error) {
      console.error('Error fetching API keys:', error);
      toast({
        title: 'Error',
        description: 'Failed to load your API keys',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const addApiKey = async () => {
    if (!user) return;
    
    if (!newKeyValue.trim()) {
      toast({
        title: 'Error',
        description: 'Please enter a valid API key',
        variant: 'destructive',
      });
      return;
    }

    setAdding(true);
    try {
      const { error } = await supabase
        .from('user_api_keys')
        .insert({
          user_id: user.id,
          provider: 'gemini',
          key_value: newKeyValue.trim(),
          is_active: true,
        });

      if (error) throw error;

      toast({
        title: 'Success',
        description: 'API key added to your pool',
      });
      setNewKeyValue('');
      setAddDialogOpen(false);
      fetchApiKeys();
      onApiKeyChanged?.();
    } catch (error) {
      console.error('Error adding API key:', error);
      toast({
        title: 'Error',
        description: 'Failed to add API key',
        variant: 'destructive',
      });
    } finally {
      setAdding(false);
    }
  };

  const toggleKeyStatus = async (id: string, currentStatus: boolean) => {
    try {
      const { error } = await supabase
        .from('user_api_keys')
        .update({ is_active: !currentStatus })
        .eq('id', id);

      if (error) throw error;

      setApiKeys(prev => 
        prev.map(key => 
          key.id === id ? { ...key, is_active: !currentStatus } : key
        )
      );

      toast({
        title: 'Success',
        description: `API key ${!currentStatus ? 'enabled' : 'disabled'}`,
      });
    } catch (error) {
      console.error('Error toggling key status:', error);
      toast({
        title: 'Error',
        description: 'Failed to update key status',
        variant: 'destructive',
      });
    }
  };

  const resetQuota = async (id: string, quotaType: 'tts' | 'flash_2_5' | 'all') => {
    try {
      const updateData: Record<string, any> = { updated_at: new Date().toISOString() };
      
      if (quotaType === 'tts' || quotaType === 'all') {
        updateData.tts_quota_exhausted = false;
        updateData.tts_quota_exhausted_date = null;
      }
      if (quotaType === 'flash_2_5' || quotaType === 'all') {
        updateData.flash_2_5_quota_exhausted = false;
        updateData.flash_2_5_quota_exhausted_date = null;
      }

      const { error } = await supabase
        .from('user_api_keys')
        .update(updateData)
        .eq('id', id);

      if (error) throw error;

      setApiKeys(prev =>
        prev.map(key =>
          key.id === id
            ? {
                ...key,
                ...(quotaType === 'tts' || quotaType === 'all' ? { tts_quota_exhausted: false, tts_quota_exhausted_date: null } : {}),
                ...(quotaType === 'flash_2_5' || quotaType === 'all' ? { flash_2_5_quota_exhausted: false, flash_2_5_quota_exhausted_date: null } : {}),
              }
            : key
        )
      );

      toast({
        title: 'Success',
        description: `${quotaType === 'all' ? 'All quotas' : (quotaType === 'flash_2_5' ? 'Flash 2.5' : 'TTS') + ' quota'} reset successfully`,
      });
    } catch (error) {
      console.error('Error resetting quota:', error);
      toast({
        title: 'Error',
        description: 'Failed to reset quota',
        variant: 'destructive',
      });
    }
  };

  const resetAllQuotas = async () => {
    if (!user) return;
    
    try {
      const { error } = await supabase
        .from('user_api_keys')
        .update({
          tts_quota_exhausted: false,
          tts_quota_exhausted_date: null,
          flash_2_5_quota_exhausted: false,
          flash_2_5_quota_exhausted_date: null,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', user.id)
        .eq('provider', 'gemini');

      if (error) throw error;

      setApiKeys(prev =>
        prev.map(key => ({
          ...key,
          tts_quota_exhausted: false,
          tts_quota_exhausted_date: null,
          flash_2_5_quota_exhausted: false,
          flash_2_5_quota_exhausted_date: null,
        }))
      );

      toast({
        title: 'Success',
        description: 'All API key quotas have been reset',
      });
    } catch (error) {
      console.error('Error resetting all quotas:', error);
      toast({
        title: 'Error',
        description: 'Failed to reset quotas',
        variant: 'destructive',
      });
    }
  };

  const deleteApiKey = async (id: string) => {
    try {
      const { error } = await supabase
        .from('user_api_keys')
        .delete()
        .eq('id', id);

      if (error) throw error;

      setApiKeys(prev => prev.filter(key => key.id !== id));

      toast({
        title: 'Success',
        description: 'API key deleted',
      });
      onApiKeyChanged?.();
    } catch (error) {
      console.error('Error deleting API key:', error);
      toast({
        title: 'Error',
        description: 'Failed to delete API key',
        variant: 'destructive',
      });
    }
  };

  const maskKey = (key: string) => {
    if (key.length <= 8) return '••••••••';
    return key.substring(0, 4) + '••••••••' + key.substring(key.length - 4);
  };

  const isQuotaExhaustedToday = (date: string | null) => {
    if (!date) return false;
    const today = new Date().toISOString().split('T')[0];
    return date === today;
  };

  if (!user) {
    return (
      <p className="text-muted-foreground">
        Please log in to manage your API keys.
      </p>
    );
  }

  const activeCount = apiKeys.filter(k => k.is_active).length;
  const ttsExhaustedCount = apiKeys.filter(k => k.tts_quota_exhausted && isQuotaExhaustedToday(k.tts_quota_exhausted_date)).length;
  const flash25ExhaustedCount = apiKeys.filter(k => k.flash_2_5_quota_exhausted && isQuotaExhaustedToday(k.flash_2_5_quota_exhausted_date)).length;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Key className="text-primary" />
            Your Gemini API Key Pool
          </CardTitle>
          <CardDescription>
            Add multiple API keys for unlimited practice. Keys are used randomly with automatic quota management and daily reset.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant={activeCount > 0 ? 'default' : 'secondary'}>
            {activeCount} Active
          </Badge>
          {ttsExhaustedCount > 0 && (
            <Badge variant="outline" className="text-orange-600 border-orange-600">
              {ttsExhaustedCount} TTS Quota Hit
            </Badge>
          )}
          {flash25ExhaustedCount > 0 && (
            <Badge variant="outline" className="text-amber-600 border-amber-600">
              {flash25ExhaustedCount} Flash 2.5 Quota Hit
            </Badge>
          )}
          {(ttsExhaustedCount > 0 || flash25ExhaustedCount > 0) && (
            <Button variant="outline" size="sm" onClick={resetAllQuotas}>
              <RefreshCw className="w-3 h-3 mr-1" />
              Reset All Quotas
            </Button>
          )}
          <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="w-4 h-4 mr-2" />
                Add Key
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add Gemini API Key</DialogTitle>
                <DialogDescription>
                  Add a new API key to your pool. Keys are used randomly for load distribution.
                  Get your key from <a href="https://ai.google.dev/gemini-api/docs/get-started/api-key" target="_blank" rel="noopener noreferrer" className="text-primary underline">Google AI Studio</a>.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="apiKey">API Key</Label>
                  <div className="relative">
                    <Input
                      id="apiKey"
                      type={showNewKey ? 'text' : 'password'}
                      placeholder="AIza..."
                      value={newKeyValue}
                      onChange={(e) => setNewKeyValue(e.target.value)}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                      onClick={() => setShowNewKey(!showNewKey)}
                    >
                      {showNewKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setAddDialogOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={addApiKey} disabled={adding}>
                  {adding ? 'Adding...' : 'Add Key'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : apiKeys.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Key className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>No API keys in your pool</p>
            <p className="text-sm">Add your Gemini API keys for unlimited AI practice</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>TTS Quota</TableHead>
                <TableHead>Flash 2.5 Quota</TableHead>
                <TableHead>Added</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apiKeys.map((key) => (
                <TableRow key={key.id}>
                  <TableCell className="font-mono text-sm">
                    {maskKey(key.key_value)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={key.is_active}
                        onCheckedChange={() => toggleKeyStatus(key.id, key.is_active)}
                      />
                      {key.is_active ? (
                        <Badge variant="outline" className="text-green-600 border-green-600">
                          <CheckCircle className="w-3 h-3 mr-1" />
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground">
                          Disabled
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {key.tts_quota_exhausted && isQuotaExhaustedToday(key.tts_quota_exhausted_date) ? (
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-orange-600 border-orange-600">
                          Exhausted
                        </Badge>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => resetQuota(key.id, 'tts')}
                          title="Reset TTS quota"
                        >
                          <RefreshCw className="w-3 h-3" />
                        </Button>
                      </div>
                    ) : (
                      <Badge variant="outline" className="text-green-600 border-green-600">
                        <CheckCircle className="w-3 h-3 mr-1" />
                        OK
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {key.flash_2_5_quota_exhausted && isQuotaExhaustedToday(key.flash_2_5_quota_exhausted_date) ? (
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-amber-600 border-amber-600">
                          Exhausted
                        </Badge>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => resetQuota(key.id, 'flash_2_5')}
                          title="Reset Flash 2.5 quota"
                        >
                          <RefreshCw className="w-3 h-3" />
                        </Button>
                      </div>
                    ) : (
                      <Badge variant="outline" className="text-green-600 border-green-600">
                        <CheckCircle className="w-3 h-3 mr-1" />
                        OK
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {new Date(key.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete API Key?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will permanently remove this API key from your pool.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => deleteApiKey(key.id)}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
