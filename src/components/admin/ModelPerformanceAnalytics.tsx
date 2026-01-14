import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/hooks/use-toast';
import { 
  RefreshCw, 
  TrendingUp,
  TrendingDown,
  Clock,
  CheckCircle,
  XCircle,
  AlertTriangle,
  BarChart3,
  Activity
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface ModelStats {
  model_name: string;
  task_type: string;
  total_calls: number;
  success_count: number;
  error_count: number;
  quota_exceeded_count: number;
  avg_response_time_ms: number | null;
  success_rate: number | null;
}

interface RecentLog {
  id: string;
  model_name: string;
  task_type: string;
  status: string;
  response_time_ms: number | null;
  error_message: string | null;
  created_at: string;
}

const TASK_TYPE_LABELS: Record<string, string> = {
  generate: 'Test Generation',
  explain: 'Answer Explanation',
  evaluate_writing: 'Writing Evaluation',
  evaluate_speaking: 'Speaking Evaluation',
  tts: 'Text-to-Speech',
};

const TASK_TYPE_COLORS: Record<string, string> = {
  generate: 'bg-purple-500',
  explain: 'bg-blue-500',
  evaluate_writing: 'bg-emerald-500',
  evaluate_speaking: 'bg-orange-500',
  tts: 'bg-rose-500',
};

export default function ModelPerformanceAnalytics() {
  const [stats, setStats] = useState<ModelStats[]>([]);
  const [recentLogs, setRecentLogs] = useState<RecentLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [timeRange, setTimeRange] = useState<string>('24');
  const { toast } = useToast();

  useEffect(() => {
    fetchData();
  }, [timeRange]);

  const fetchData = async () => {
    try {
      // Fetch stats using RPC
      const { data: statsData, error: statsError } = await supabase
        .rpc('get_model_performance_stats', { p_hours: parseInt(timeRange) });

      if (statsError) throw statsError;

      // Fetch recent logs
      const { data: logsData, error: logsError } = await supabase
        .from('model_performance_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

      if (logsError) throw logsError;

      setStats(statsData || []);
      setRecentLogs(logsData || []);
    } catch (error) {
      console.error('Error fetching performance data:', error);
      toast({
        title: 'Error',
        description: 'Failed to load performance data',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const refreshData = async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'success':
        return <CheckCircle className="w-4 h-4 text-green-500" />;
      case 'error':
        return <XCircle className="w-4 h-4 text-red-500" />;
      case 'quota_exceeded':
        return <AlertTriangle className="w-4 h-4 text-amber-500" />;
      default:
        return null;
    }
  };

  const getSuccessRateColor = (rate: number | null) => {
    if (rate === null) return 'text-muted-foreground';
    if (rate >= 90) return 'text-green-500';
    if (rate >= 70) return 'text-amber-500';
    return 'text-red-500';
  };

  const getTrendIcon = (rate: number | null) => {
    if (rate === null) return null;
    if (rate >= 90) return <TrendingUp className="w-4 h-4 text-green-500" />;
    if (rate >= 70) return <TrendingDown className="w-4 h-4 text-amber-500" />;
    return <TrendingDown className="w-4 h-4 text-red-500" />;
  };

  // Calculate aggregate stats
  const totalCalls = stats.reduce((sum, s) => sum + s.total_calls, 0);
  const totalSuccess = stats.reduce((sum, s) => sum + s.success_count, 0);
  const totalErrors = stats.reduce((sum, s) => sum + s.error_count, 0);
  const totalQuotaExceeded = stats.reduce((sum, s) => sum + s.quota_exceeded_count, 0);
  const overallSuccessRate = totalCalls > 0 ? (totalSuccess / totalCalls) * 100 : 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-primary" />
          Model Performance Analytics
        </h2>
        <div className="flex items-center gap-2">
          <Select value={timeRange} onValueChange={setTimeRange}>
            <SelectTrigger className="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Last 1 hour</SelectItem>
              <SelectItem value="6">Last 6 hours</SelectItem>
              <SelectItem value="24">Last 24 hours</SelectItem>
              <SelectItem value="72">Last 3 days</SelectItem>
              <SelectItem value="168">Last 7 days</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={refreshData} disabled={refreshing}>
            <RefreshCw className={`w-4 h-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total API Calls</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{totalCalls.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Success Rate</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-3xl font-bold ${getSuccessRateColor(overallSuccessRate)}`}>
              {overallSuccessRate.toFixed(1)}%
            </div>
            <Progress value={overallSuccessRate} className="mt-2 h-2" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Errors</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-red-500">{totalErrors}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Quota Exceeded</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-amber-500">{totalQuotaExceeded}</div>
          </CardContent>
        </Card>
      </div>

      {/* Model Stats Table */}
      <Card>
        <CardHeader>
          <CardTitle>Performance by Model</CardTitle>
          <CardDescription>Success rates and response times for each model and task type</CardDescription>
        </CardHeader>
        <CardContent>
          {stats.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Activity className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>No performance data available</p>
              <p className="text-sm">Data will appear as API calls are made</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead>Task Type</TableHead>
                  <TableHead className="text-center">Total Calls</TableHead>
                  <TableHead className="text-center">Success</TableHead>
                  <TableHead className="text-center">Errors</TableHead>
                  <TableHead className="text-center">Quota Hit</TableHead>
                  <TableHead className="text-center">Avg Response</TableHead>
                  <TableHead className="text-center">Success Rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats.map((stat, idx) => (
                  <TableRow key={`${stat.model_name}-${stat.task_type}-${idx}`}>
                    <TableCell className="font-mono text-sm">{stat.model_name}</TableCell>
                    <TableCell>
                      <Badge 
                        variant="outline" 
                        className={`${TASK_TYPE_COLORS[stat.task_type] || 'bg-gray-500'} text-white border-0`}
                      >
                        {TASK_TYPE_LABELS[stat.task_type] || stat.task_type}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center font-medium">{stat.total_calls}</TableCell>
                    <TableCell className="text-center text-green-600">{stat.success_count}</TableCell>
                    <TableCell className="text-center text-red-600">{stat.error_count}</TableCell>
                    <TableCell className="text-center text-amber-600">{stat.quota_exceeded_count}</TableCell>
                    <TableCell className="text-center">
                      {stat.avg_response_time_ms ? (
                        <div className="flex items-center justify-center gap-1">
                          <Clock className="w-3 h-3 text-muted-foreground" />
                          <span>{Math.round(stat.avg_response_time_ms)}ms</span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      <div className="flex items-center justify-center gap-1">
                        {getTrendIcon(stat.success_rate)}
                        <span className={getSuccessRateColor(stat.success_rate)}>
                          {stat.success_rate !== null ? `${stat.success_rate}%` : '-'}
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Recent Logs */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="w-5 h-5" />
            Recent API Calls
          </CardTitle>
          <CardDescription>Last 50 API calls with status and timing</CardDescription>
        </CardHeader>
        <CardContent>
          {recentLogs.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <p>No recent logs available</p>
            </div>
          ) : (
            <div className="max-h-[400px] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[180px]">Time</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead>Task</TableHead>
                    <TableHead className="text-center">Status</TableHead>
                    <TableHead className="text-center">Response Time</TableHead>
                    <TableHead>Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentLogs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(log.created_at).toLocaleString()}
                      </TableCell>
                      <TableCell className="font-mono text-sm">{log.model_name}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {TASK_TYPE_LABELS[log.task_type] || log.task_type}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-center">
                        <div className="flex items-center justify-center">
                          {getStatusIcon(log.status)}
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        {log.response_time_ms ? `${log.response_time_ms}ms` : '-'}
                      </TableCell>
                      <TableCell className="text-sm text-red-500 max-w-[200px] truncate">
                        {log.error_message || '-'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
