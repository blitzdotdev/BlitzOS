import { Archive } from 'lucide-react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { cn } from '@/lib/utils';

const CONFIRM_RESET_DELAY_MS = 3500;

type SidebarConfirmArchiveButtonProps = {
  label: string;
  confirmLabel: string;
  className?: string;
  iconClassName?: string;
  onConfirm: () => void;
} & Omit<ComponentPropsWithoutRef<'button'>, 'type' | 'onConfirm'>;

export const SidebarConfirmArchiveButton = forwardRef<
  HTMLButtonElement,
  SidebarConfirmArchiveButtonProps
>(function SidebarConfirmArchiveButton(
  {
    label,
    confirmLabel,
    className,
    iconClassName,
    onConfirm,
    onBlur,
    onClick,
    onKeyDown,
    onMouseLeave,
    ...buttonProps
  },
  ref
) {
  const [isConfirming, setIsConfirming] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearResetTimer = useCallback(() => {
    if (resetTimerRef.current === null) return;
    clearTimeout(resetTimerRef.current);
    resetTimerRef.current = null;
  }, []);

  const resetConfirming = useCallback(() => {
    clearResetTimer();
    setIsConfirming(false);
  }, [clearResetTimer]);

  const armConfirming = useCallback(() => {
    clearResetTimer();
    setIsConfirming(true);
    resetTimerRef.current = setTimeout(() => {
      resetTimerRef.current = null;
      setIsConfirming(false);
    }, CONFIRM_RESET_DELAY_MS);
  }, [clearResetTimer]);

  useEffect(() => clearResetTimer, [clearResetTimer]);

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (!isConfirming) {
      armConfirming();
      return;
    }

    resetConfirming();
    onConfirm();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) {
      return;
    }

    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    resetConfirming();
  };

  const handleBlur = (event: FocusEvent<HTMLButtonElement>) => {
    onBlur?.(event);
    resetConfirming();
  };

  const handleMouseLeave = (event: MouseEvent<HTMLButtonElement>) => {
    onMouseLeave?.(event);
    if (isConfirming) {
      resetConfirming();
    }
  };

  return (
    <button
      {...buttonProps}
      ref={ref}
      type="button"
      className={cn(
        'inline-flex items-center justify-center rounded-sm',
        'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring/40',
        isConfirming
          ? 'relative z-10 h-5 min-w-14 overflow-hidden whitespace-nowrap rounded-full border border-destructive/20 bg-sidebar px-2 text-[11px] font-medium leading-none text-destructive shadow-xs transition-none hover:border-destructive/25 hover:bg-sidebar hover:text-destructive dark:border-destructive/30 dark:text-destructive-foreground'
          : 'h-5 w-5 text-sidebar-foreground-muted/80 transition-[opacity,color,background-color,border-color,width] duration-100 hover:text-sidebar-foreground',
        className
      )}
      aria-label={isConfirming ? `Confirm ${label}` : label}
      onClick={handleClick}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      onMouseLeave={handleMouseLeave}
    >
      {isConfirming ? (
        <>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-full bg-destructive/12 dark:bg-destructive/35"
          />
          <span className="relative z-10">{confirmLabel}</span>
        </>
      ) : (
        <Archive className={cn('h-3.5 w-3.5', iconClassName)} />
      )}
    </button>
  );
});
