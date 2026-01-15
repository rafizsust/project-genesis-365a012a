/**
 * Browser Detection Utilities
 * Critical: Edge and Chrome must be treated as different speech engines
 */

export interface BrowserInfo {
  isEdge: boolean;
  isChrome: boolean;
  isSafari: boolean;
  isFirefox: boolean;
  isMobile: boolean;
  isAndroid: boolean;
  browserName: string;
}

export function detectBrowser(): BrowserInfo {
  const ua = navigator.userAgent;
  
  // Edge detection MUST come before Chrome (Edge includes "Chrome" in UA)
  const isEdge = ua.includes("Edg");
  const isChrome = ua.includes("Chrome") && !isEdge;
  const isSafari = ua.includes("Safari") && !ua.includes("Chrome");
  const isFirefox = ua.includes("Firefox");
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  const isAndroid = ua.includes("Android");
  
  let browserName = "Unknown";
  if (isEdge) browserName = "Edge";
  else if (isChrome) browserName = "Chrome";
  else if (isSafari) browserName = "Safari";
  else if (isFirefox) browserName = "Firefox";
  
  return {
    isEdge,
    isChrome,
    isSafari,
    isFirefox,
    isMobile,
    isAndroid,
    browserName
  };
}

export function isSpeechRecognitionSupported(): boolean {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}
