import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';

import { cn } from '@/lib/utils';
import { useSafeAreaInsets } from '@/hooks/use-safe-area-insets';

const Popover = PopoverPrimitive.Root;

const PopoverTrigger = PopoverPrimitive.Trigger;

/** Positions the popover without Trigger's open-on-click behavior — for
 *  controlled popovers whose anchor owns its own click semantics. */
const PopoverAnchor = PopoverPrimitive.Anchor;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> & {
    portalContainer?: HTMLElement | null;
  }
>(
  (
    { className, align = 'center', sideOffset = 4, collisionPadding, portalContainer, ...props },
    ref
  ) => {
    const safeArea = useSafeAreaInsets();
    const baseCollisionPadding = { top: 8, right: 8, bottom: 8, left: 8 };
    const safeAreaPadding = {
      top: baseCollisionPadding.top + safeArea.top,
      right: baseCollisionPadding.right + safeArea.right,
      bottom: baseCollisionPadding.bottom + safeArea.bottom,
      left: baseCollisionPadding.left + safeArea.left,
    };
    const mergedCollisionPadding =
      typeof collisionPadding === 'number'
        ? {
            top: Math.max(safeAreaPadding.top, collisionPadding),
            right: Math.max(safeAreaPadding.right, collisionPadding),
            bottom: Math.max(safeAreaPadding.bottom, collisionPadding),
            left: Math.max(safeAreaPadding.left, collisionPadding),
          }
        : collisionPadding
          ? {
              top: Math.max(safeAreaPadding.top, collisionPadding.top ?? 0),
              right: Math.max(safeAreaPadding.right, collisionPadding.right ?? 0),
              bottom: Math.max(safeAreaPadding.bottom, collisionPadding.bottom ?? 0),
              left: Math.max(safeAreaPadding.left, collisionPadding.left ?? 0),
            }
          : safeAreaPadding;
    return (
      <PopoverPrimitive.Portal container={portalContainer ?? undefined}>
        <PopoverPrimitive.Content
          ref={ref}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={mergedCollisionPadding}
          className={cn(
            'scroll-pro scrollbar-pro [scrollbar-gutter:auto] z-[var(--z-popover)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md outline-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
            className
          )}
          {...props}
        />
      </PopoverPrimitive.Portal>
    );
  }
);
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent };
