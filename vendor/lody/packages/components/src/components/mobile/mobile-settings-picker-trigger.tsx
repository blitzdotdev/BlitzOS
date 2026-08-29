import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  MobileInlinePicker,
  type MobileInlinePickerOption,
} from '@/components/mobile/mobile-inline-picker';

export function MobileSettingsPickerTrigger<T extends string>({
  id,
  ariaLabel,
  value,
  options,
  onChange,
  triggerLabel,
  triggerIcon,
  searchable,
  searchPlaceholder,
}: {
  id: string;
  ariaLabel: string;
  value: T;
  options: MobileInlinePickerOption<T>[];
  onChange: (next: T) => void;
  triggerLabel: ReactNode;
  triggerIcon?: ReactNode;
  searchable?: boolean;
  searchPlaceholder?: string;
}) {
  return (
    <div className={cn('inline-block max-w-[60vw]')}>
      <MobileInlinePicker<T>
        id={id}
        value={value}
        onChange={onChange}
        options={options}
        ariaLabel={ariaLabel}
        searchable={searchable}
        searchPlaceholder={searchPlaceholder}
        triggerClassName="w-auto"
        triggerContent={
          <>
            {triggerIcon ? <span className="shrink-0">{triggerIcon}</span> : null}
            <span className="min-w-0 truncate text-right">{triggerLabel}</span>
            <ChevronDown
              className="h-3.5 w-3.5 shrink-0 opacity-60"
              strokeWidth={2}
              aria-hidden="true"
            />
          </>
        }
      />
    </div>
  );
}
