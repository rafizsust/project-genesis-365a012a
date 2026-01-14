import { useCallback, useEffect, useState } from 'react';

interface NotificationOptions {
  title: string;
  body: string;
  icon?: string;
  tag?: string;
  onClick?: () => void;
}

export function useBrowserNotifications() {
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [isSupported, setIsSupported] = useState(false);

  useEffect(() => {
    // Check if browser supports notifications
    if ('Notification' in window) {
      setIsSupported(true);
      setPermission(Notification.permission);
    }
  }, []);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (!isSupported) return false;

    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      return result === 'granted';
    } catch (error) {
      console.error('Failed to request notification permission:', error);
      return false;
    }
  }, [isSupported]);

  const showNotification = useCallback(
    async ({ title, body, icon, tag, onClick }: NotificationOptions): Promise<boolean> => {
      console.log('[Notifications] showNotification called:', { title, body, tag, hasOnClick: !!onClick });
      
      if (!isSupported) {
        console.log('[Notifications] Not supported in this browser');
        return false;
      }

      // Request permission if not already granted
      let currentPermission = permission;
      if (currentPermission === 'default') {
        console.log('[Notifications] Permission is default, requesting...');
        const granted = await requestPermission();
        if (!granted) {
          console.log('[Notifications] Permission request denied');
          return false;
        }
        currentPermission = 'granted';
      }

      if (currentPermission !== 'granted') {
        console.log('[Notifications] Permission denied:', currentPermission);
        return false;
      }

      try {
        console.log('[Notifications] Creating notification...');
        const notification = new Notification(title, {
          body,
          icon: icon || '/favicon.svg',
          tag: tag || 'ielts-dhaka',
          requireInteraction: true, // Keep notification visible until user interacts
        });

        if (onClick) {
          notification.onclick = (event) => {
            event.preventDefault();
            console.log('[Notifications] Notification clicked, executing onClick handler');
            try {
              window.focus();
              onClick();
            } catch (e) {
              console.error('[Notifications] onClick handler error:', e);
            }
            notification.close();
          };
        }

        // Auto-close after 10 seconds (increased from 5)
        setTimeout(() => {
          console.log('[Notifications] Auto-closing notification');
          notification.close();
        }, 10000);

        console.log('[Notifications] Notification created successfully');
        return true;
      } catch (error) {
        console.error('[Notifications] Failed to show notification:', error);
        return false;
      }
    },
    [isSupported, permission, requestPermission]
  );

  const notifyEvaluationComplete = useCallback(
    (testTopic?: string, onClickNavigate?: () => void) => {
      showNotification({
        title: '🎉 Speaking Evaluation Ready!',
        body: testTopic 
          ? `Your "${testTopic}" speaking test has been evaluated.`
          : 'Your speaking test results are now available.',
        tag: 'speaking-eval-complete',
        onClick: onClickNavigate,
      });
    },
    [showNotification]
  );

  const notifyEvaluationFailed = useCallback(
    (reason?: string) => {
      showNotification({
        title: '❌ Evaluation Failed',
        body: reason || 'Your speaking evaluation failed after multiple attempts. Please try again or contact support.',
        tag: 'speaking-eval-failed',
      });
    },
    [showNotification]
  );

  return {
    isSupported,
    permission,
    requestPermission,
    showNotification,
    notifyEvaluationComplete,
    notifyEvaluationFailed,
  };
}
