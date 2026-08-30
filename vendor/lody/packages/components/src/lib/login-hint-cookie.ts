const LOGIN_HINT_COOKIE_NAME = 'lody_logged_in';
const LOGIN_HINT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function setLoginHintCookie(isLoggedIn: boolean): void {
  if (typeof document === 'undefined') {
    return;
  }

  const secure =
    typeof window !== 'undefined' && window.location.protocol === 'https:' ? '; Secure' : '';

  if (isLoggedIn) {
    document.cookie = `${LOGIN_HINT_COOKIE_NAME}=1; Path=/; Max-Age=${LOGIN_HINT_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
    return;
  }

  document.cookie = `${LOGIN_HINT_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}
