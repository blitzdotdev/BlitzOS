/** Runtime-resolved through vitest.config.ts; the test asserts the real Zod result. */
declare module "@lody/shared/message-schemas" {
  export const PermissionResponseMessageSchema: {
    safeParse(value: object): { success: true } | { success: false; error: Error };
  };
}
