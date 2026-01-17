import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { z } from 'zod';
import { KeyRound, Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const emailSchema = z.string().email('Please enter a valid email address');
const passwordSchema = z.string().min(6, 'Password must be at least 6 characters');

const TERMS_ACCEPTED_KEY = 'ieltsai_terms_accepted';
const NOTIFICATION_REQUESTED_KEY = 'ieltsai_notification_requested';

// Request notification permission on login (only once per session)
const requestNotificationPermissionOnLogin = () => {
  // Check if we've already requested in this browser
  if (localStorage.getItem(NOTIFICATION_REQUESTED_KEY) === 'true') {
    return;
  }
  
  // Check if browser supports notifications
  if (!('Notification' in window)) {
    return;
  }
  
  // If already granted or denied, don't ask again
  if (Notification.permission !== 'default') {
    localStorage.setItem(NOTIFICATION_REQUESTED_KEY, 'true');
    return;
  }
  
  // Request permission after a short delay (don't interrupt login flow)
  setTimeout(() => {
    Notification.requestPermission().then((permission) => {
      localStorage.setItem(NOTIFICATION_REQUESTED_KEY, 'true');
      if (permission === 'granted') {
        console.log('[Auth] Notification permission granted on login');
      }
    }).catch((err) => {
      console.warn('[Auth] Failed to request notification permission:', err);
    });
  }, 2000);
};

const Auth = () => {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  
  const { signIn, signUp, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Check if terms are accepted before allowing access
  useEffect(() => {
    const termsAccepted = localStorage.getItem(TERMS_ACCEPTED_KEY) === 'true';
    if (!termsAccepted) {
      navigate('/onboarding');
      return;
    }
  }, [navigate]);

  useEffect(() => {
    if (user) {
      // Check for returnTo parameter first (for pending submissions)
      const params = new URLSearchParams(location.search);
      const returnTo = params.get('returnTo');
      const redirectPath = params.get('redirect');
      
      if (returnTo) {
        // If there's a pending submission, navigate directly to the test
        // The test page will handle restoring state and auto-submitting
        navigate(returnTo);
      } else if (redirectPath) {
        navigate(redirectPath);
      } else {
        // Check if user needs onboarding (API key setup)
        navigate('/onboarding');
      }
    }
  }, [user, navigate, location.search]);

  const validateForm = () => {
    const newErrors: { email?: string; password?: string } = {};
    
    const emailResult = emailSchema.safeParse(email);
    if (!emailResult.success) {
      newErrors.email = emailResult.error.errors[0].message;
    }
    
    const passwordResult = passwordSchema.safeParse(password);
    if (!passwordResult.success) {
      newErrors.password = passwordResult.error.errors[0].message;
    }
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateForm()) return;
    
    setLoading(true);

    try {
      if (isLogin) {
        const { error } = await signIn(email, password);
        if (error) {
          if (error.message.includes('Invalid login credentials')) {
            toast.error('Invalid email or password');
          } else {
            toast.error(error.message);
          }
        } else {
          toast.success('Welcome back!');
          // Request notification permission on successful login
          requestNotificationPermissionOnLogin();
          // Redirection handled by useEffect
        }
      } else {
        const { error } = await signUp(email, password, fullName);
        if (error) {
          if (error.message.includes('already registered')) {
            toast.error('This email is already registered. Please log in instead.');
          } else {
            toast.error(error.message);
          }
        } else {
          if (geminiApiKey.trim()) {
            sessionStorage.setItem('tempGeminiApiKey', geminiApiKey.trim());
            toast.success('Account created! Please check your email to confirm your account, then log in and save your API key in settings.');
          } else {
            toast.success('Account created! Please check your email to confirm your account.');
          }
          setEmail('');
          setPassword('');
          setFullName('');
          setGeminiApiKey('');
          // Redirection handled by useEffect
        }
      }
    } catch (error: any) {
      toast.error('An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="bg-card border border-border rounded-2xl p-8 shadow-xl">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-foreground mb-2">
              {isLogin ? 'Welcome Back' : 'Create Account'}
            </h1>
            <p className="text-muted-foreground">
              {isLogin 
                ? 'Sign in to access your IELTS practice' 
                : 'Join thousands of successful IELTS students'}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            {!isLogin && (
              <div className="space-y-2">
                <Label htmlFor="fullName">Full Name</Label>
                <Input
                  id="fullName"
                  type="text"
                  placeholder="Enter your full name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="bg-background"
                />
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="Enter your email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setErrors((prev) => ({ ...prev, email: undefined }));
                }}
                className={`bg-background ${errors.email ? 'border-destructive' : ''}`}
              />
              {errors.email && (
                <p className="text-sm text-destructive">{errors.email}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setErrors((prev) => ({ ...prev, password: undefined }));
                }}
                className={`bg-background ${errors.password ? 'border-destructive' : ''}`}
              />
              {errors.password && (
                <p className="text-sm text-destructive">{errors.password}</p>
              )}
            </div>

            {!isLogin && (
              <div className="space-y-2">
                <Label htmlFor="gemini-api-key" className="flex items-center gap-2">
                  <KeyRound size={16} />
                  Gemini API Key (Optional)
                  <Tooltip>
                    <TooltipTrigger>
                      <Info size={14} className="text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      <p>Provide your Gemini API key now, or add it later in your settings.</p>
                      <p className="mt-1">You can get your API key from <a href="https://ai.google.dev/gemini-api/docs/get-started/api-key" target="_blank" rel="noopener noreferrer" className="text-primary underline">Google AI Studio</a>.</p>
                    </TooltipContent>
                  </Tooltip>
                </Label>
                <Input
                  id="gemini-api-key"
                  type="password"
                  placeholder="Enter your Gemini API key (optional)"
                  value={geminiApiKey}
                  onChange={(e) => setGeminiApiKey(e.target.value)}
                  className="bg-background"
                />
              </div>
            )}

            <Button
              type="submit"
              className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
              disabled={loading}
            >
              {loading ? 'Please wait...' : (isLogin ? 'Sign In' : 'Create Account')}
            </Button>
          </form>

          <div className="mt-6 text-center">
            <button
              type="button"
              onClick={() => {
                setIsLogin(!isLogin);
                setErrors({});
              }}
              className="text-primary hover:underline text-sm"
            >
              {isLogin 
                ? "Don't have an account? Sign up" 
                : 'Already have an account? Sign in'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Auth;