export type AppDeviceClass = 'mobile' | 'desktop' | 'tablet' | 'unknown';

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: {
    mobile?: boolean;
  };
};

export function detectAppDeviceClass(): AppDeviceClass {
  if (typeof window === 'undefined') {
    return 'unknown';
  }

  const navigator = window.navigator as NavigatorWithUserAgentData;
  if (navigator.userAgentData?.mobile === true) {
    return 'mobile';
  }

  const userAgent = navigator.userAgent.toLowerCase();
  if (
    /ipad|tablet|playbook|silk/.test(userAgent) ||
    (/android/.test(userAgent) && !/mobile/.test(userAgent))
  ) {
    return 'tablet';
  }

  if (/mobi|iphone|ipod|android/.test(userAgent)) {
    return 'mobile';
  }

  return 'desktop';
}
