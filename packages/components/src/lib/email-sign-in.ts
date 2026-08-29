export type EmailSignInInput = {
  email: string;
  password: string;
  rememberMe: true;
  callbackURL?: string;
};

type BuildEmailSignInInputOptions = {
  email: string;
  password: string;
  callbackURL: string;
  isNativeApp: boolean;
};

export function buildEmailSignInInput({
  email,
  password,
  callbackURL,
  isNativeApp,
}: BuildEmailSignInInputOptions): EmailSignInInput {
  const input: EmailSignInInput = {
    email,
    password,
    rememberMe: true,
  };

  // better-auth-capacitor 0.3.x treats any native `/sign-in*` response with
  // `data.url` as OAuth and opens `/capacitor-authorization-proxy`. Rejected:
  // passing callbackURL for native email sign-in, because the proxy requires an
  // OAuth `state` param and shows a Convex 400 after successful password auth.
  if (!isNativeApp) {
    input.callbackURL = callbackURL;
  }

  return input;
}
