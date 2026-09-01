import { type ReactNode } from 'react';

/* Shared helpers for the mobile model-picker chip label.

   This file used to also export the in-session `MobileSessionComposerFooter`
   (model / thinking / fast row). That component was replaced by the
   consolidated run-config control (`mobile-session-run-config.tsx` +
   `mobile-run-config-sheet.tsx`) and removed. The two helpers below survive
   because the new-chat composer (`chat-landing.tsx`) + its story still use
   them: the model picker is the only chip allowed to shrink/truncate, keeping
   its tail via the rtl trick so a long "provider/model" name loses the prefix
   rather than the model. */
export const mobileModelPickerTriggerClassName = 'h-8 min-w-0 px-2 py-1 text-sm';

export function MobileModelPickerLabel({ children }: { children: ReactNode }) {
  return (
    <span className="block min-w-0 max-w-full truncate text-left [direction:rtl]">
      <span dir="ltr">{children}</span>
    </span>
  );
}
