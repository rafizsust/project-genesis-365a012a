import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { 
  Key, 
  Plus, 
  Trash2, 
  RefreshCw, 
  Settings, 
  CheckCircle,
  Eye,
  EyeOff
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

interface ApiKey {
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

export default function AdminSettings() {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKeyValue, setNewKeyValue] = useState('');
  const [showNewKey, setShowNewKey] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [adding, setAdding] = useState(false);
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

  const addApiKey = async () => {
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
        .from('api_keys')
        .insert({
          provider: 'gemini',
          key_value: newKeyValue.trim(),
          is_active: true,
          error_count: 0,
        });

      if (error) throw error;

      toast({
        title: 'Success',
        description: 'API key added successfully',
      });
      setNewKeyValue('');
      setAddDialogOpen(false);
      fetchApiKeys();
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
        .from('api_keys')
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

  const deleteApiKey = async (id: string) => {
    try {
      const { error } = await supabase
        .from('api_keys')
        .delete()
        .eq('id', id);

      if (error) throw error;

      setApiKeys(prev => prev.filter(key => key.id !== id));

      toast({
        title: 'Success',
        description: 'API key deleted',
      });
    } catch (error) {
      console.error('Error deleting API key:', error);
      toast({
        title: 'Error',
        description: 'Failed to delete API key',
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
        .from('api_keys')
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
    try {
      const { error } = await supabase
        .from('api_keys')
        .update({
          tts_quota_exhausted: false,
          tts_quota_exhausted_date: null,
          flash_2_5_quota_exhausted: false,
          flash_2_5_quota_exhausted_date: null,
          updated_at: new Date().toISOString(),
        })
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

  const maskKey = (key: string) => {
    if (key.length <= 8) return '••••••••';
    return key.substring(0, 4) + '••••••••' + key.substring(key.length - 4);
  };

  const isQuotaExhaustedToday = (date: string | null) => {
    if (!date) return false;
    const today = new Date().toISOString().split('T')[0];
    return date === today;
  };

  const activeCount = apiKeys.filter(k => k.is_active).length;
  const ttsExhaustedCount = apiKeys.filter(k => k.tts_quota_exhausted && isQuotaExhaustedToday(k.tts_quota_exhausted_date)).length;
  const flash25ExhaustedCount = apiKeys.filter(k => k.flash_2_5_quota_exhausted && isQuotaExhaustedToday(k.flash_2_5_quota_exhausted_date)).length;

  return (
    <div className="p-6 bg-gradient-to-br from-background via-background to-primary/5 min-h-full">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 rounded-xl bg-gradient-to-br from-primary to-accent">
            <Settings className="w-6 h-6 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-3xl font-bold font-heading">Admin Settings</h1>
            <p className="text-muted-foreground">Manage API keys and system configuration</p>
          </div>
        </div>
      </div>

      {/* API Keys Section */}
      <Card className="border-0 shadow-lg">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Key className="text-primary" />
              Gemini API Keys
            </CardTitle>
            <CardDescription>
              Manage the pool of API keys used for AI generation (Random rotation with quota management)
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant={activeCount > 0 ? 'default' : 'destructive'}>
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
                  <DialogTitle>Add New Gemini API Key</DialogTitle>
                  <DialogDescription>
                    Add a new API key to the rotation pool. Keys are used randomly with automatic quota management.
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
              <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : apiKeys.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Key className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>No API keys configured</p>
              <p className="text-sm">Add your first Gemini API key to enable AI generation</p>
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
                              This will permanently remove this API key from the rotation pool.
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
    </div>
  );
}
