import {
  createContext,
  forwardRef,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactNode,
} from 'react';

import { cn } from '@/lib/utils';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';

export const ACTIVE_TAB_MIN_WIDTH = 180;

export type AdaptiveTabStripItemLayout = {
  id: string;
  width: number;
  marginRight: number;
};

export type AdaptiveTabStripLayout = {
  paddingLeft: number;
  paddingRight: number;
  items: AdaptiveTabStripItemLayout[];
};

export type AllocateAdaptiveTabStripLayoutOptions = {
  viewportWidth: number;
  itemIds: readonly string[];
  activeItemId: string | null;
  gap: number;
  paddingLeft: number;
  paddingRight: number;
  activeMinWidth: number;
};

const toNonNegativeInteger = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

function distributeEvenly(totalWidth: number, itemCount: number): number[] {
  if (itemCount <= 0) return [];

  const baseWidth = Math.floor(totalWidth / itemCount);
  let remainder = totalWidth - baseWidth * itemCount;

  return Array.from({ length: itemCount }, () => baseWidth + (remainder-- > 0 ? 1 : 0));
}

export function allocateAdaptiveTabStripLayout({
  viewportWidth,
  itemIds,
  activeItemId,
  gap,
  paddingLeft,
  paddingRight,
  activeMinWidth,
}: AllocateAdaptiveTabStripLayoutOptions): AdaptiveTabStripLayout {
  const width = toNonNegativeInteger(viewportWidth);
  const effectivePaddingLeft = Math.min(toNonNegativeInteger(paddingLeft), width);
  const effectivePaddingRight = Math.min(
    toNonNegativeInteger(paddingRight),
    width - effectivePaddingLeft
  );
  const contentWidth = width - effectivePaddingLeft - effectivePaddingRight;
  const gapCount = Math.max(0, itemIds.length - 1);
  const effectiveGap =
    gapCount === 0 ? 0 : Math.min(toNonNegativeInteger(gap), Math.floor(contentWidth / gapCount));
  const itemWidthBudget = contentWidth - effectiveGap * gapCount;

  if (itemIds.length === 0) {
    return {
      paddingLeft: effectivePaddingLeft,
      paddingRight: effectivePaddingRight,
      items: [],
    };
  }

  const activeIndex = activeItemId === null ? -1 : itemIds.indexOf(activeItemId);
  let itemWidths: number[];

  const minimumActiveWidth = toNonNegativeInteger(activeMinWidth);
  const allTabsFitMinimum = itemWidthBudget >= minimumActiveWidth * itemIds.length;

  if (itemIds.length === 1 || activeIndex === -1 || allTabsFitMinimum) {
    itemWidths = distributeEvenly(itemWidthBudget, itemIds.length);
  } else {
    const activeWidth = Math.min(minimumActiveWidth, itemWidthBudget);
    const inactiveWidths = distributeEvenly(itemWidthBudget - activeWidth, itemIds.length - 1);
    let inactiveIndex = 0;

    itemWidths = itemIds.map((_, index) =>
      index === activeIndex ? activeWidth : inactiveWidths[inactiveIndex++]!
    );
  }

  return {
    paddingLeft: effectivePaddingLeft,
    paddingRight: effectivePaddingRight,
    items: itemIds.map((id, index) => ({
      id,
      width: itemWidths[index]!,
      marginRight: index === itemIds.length - 1 ? 0 : effectiveGap,
    })),
  };
}

type AdaptiveTabStripContextValue = {
  itemLayoutById: ReadonlyMap<string, AdaptiveTabStripItemLayout> | null;
  fallbackMarginById: ReadonlyMap<string, number>;
};

const AdaptiveTabStripContext = createContext<AdaptiveTabStripContextValue | null>(null);

export type AdaptiveTabStripProps = Omit<ComponentPropsWithoutRef<'div'>, 'children'> & {
  itemIds: readonly string[];
  activeItemId: string | null;
  children: ReactNode;
  viewportClassName?: string;
  gap?: number;
  paddingLeft?: number;
  paddingRight?: number;
  activeMinWidth?: number;
};

export function AdaptiveTabStrip({
  itemIds,
  activeItemId,
  children,
  viewportClassName,
  gap = 6,
  paddingLeft = 8,
  paddingRight = 8,
  activeMinWidth = ACTIVE_TAB_MIN_WIDTH,
  className,
  style,
  ...props
}: AdaptiveTabStripProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;

    const measure = () => {
      const nextWidth = viewport.clientWidth;
      setViewportWidth((currentWidth) => (currentWidth === nextWidth ? currentWidth : nextWidth));
    };

    measure();
    return observeResizeOnAnimationFrame(viewport, measure);
  }, []);

  const layout = useMemo(
    () =>
      viewportWidth === null
        ? null
        : allocateAdaptiveTabStripLayout({
            viewportWidth,
            itemIds,
            activeItemId,
            gap,
            paddingLeft,
            paddingRight,
            activeMinWidth,
          }),
    [activeItemId, activeMinWidth, gap, itemIds, paddingLeft, paddingRight, viewportWidth]
  );
  const contextValue = useMemo<AdaptiveTabStripContextValue>(() => {
    const fallbackMarginById = new Map<string, number>();
    itemIds.forEach((id, index) => {
      fallbackMarginById.set(id, index === itemIds.length - 1 ? 0 : gap);
    });

    return {
      itemLayoutById: layout === null ? null : new Map(layout.items.map((item) => [item.id, item])),
      fallbackMarginById,
    };
  }, [gap, itemIds, layout]);

  // The viewport is the flex remainder after the surrounding fixed controls.
  // Integer widths and margins replace Radix's max-content table wrapper, which
  // made equal flex children wider than the visible tab area.
  return (
    <div
      ref={viewportRef}
      className={cn('min-w-0 flex-1 overflow-hidden', viewportClassName)}
      data-adaptive-tab-strip-viewport=""
    >
      <AdaptiveTabStripContext.Provider value={contextValue}>
        <div
          {...props}
          className={cn('flex w-full items-center', className)}
          style={
            {
              ...style,
              boxSizing: 'border-box',
              paddingLeft: layout?.paddingLeft ?? paddingLeft,
              paddingRight: layout?.paddingRight ?? paddingRight,
            } as CSSProperties
          }
          data-adaptive-tab-strip=""
        >
          {children}
        </div>
      </AdaptiveTabStripContext.Provider>
    </div>
  );
}

export type AdaptiveTabStripItemProps = ComponentPropsWithoutRef<'div'> & {
  itemId: string;
};

export const AdaptiveTabStripItem = forwardRef<HTMLDivElement, AdaptiveTabStripItemProps>(
  function AdaptiveTabStripItem({ itemId, className, style, ...props }, ref) {
    const context = useContext(AdaptiveTabStripContext);
    if (!context) {
      throw new Error('AdaptiveTabStripItem must be rendered inside AdaptiveTabStrip');
    }

    const itemLayout = context.itemLayoutById?.get(itemId);
    const layoutStyle: CSSProperties = itemLayout
      ? {
          flex: '0 0 auto',
          width: itemLayout.width,
          marginRight: itemLayout.marginRight,
        }
      : {
          flex: '1 1 0',
          marginRight: context.fallbackMarginById.get(itemId) ?? 0,
        };

    return (
      <div
        {...props}
        ref={ref}
        className={cn('min-w-0 overflow-hidden', className)}
        style={{ ...style, ...layoutStyle }}
        data-adaptive-tab-strip-item={itemId}
      />
    );
  }
);
