/* oxlint-disable no-use-before-define */

import {
  RESOLVE_VISUAL_ANNOTATION_ANCHORS_MESSAGE_TYPE,
  SET_ANNOTATION_MODE_MESSAGE_TYPE,
  VISUAL_ANNOTATION_ANCHORS_RESOLVED_MESSAGE_TYPE,
  VISUAL_ANNOTATION_STYLE_FIELDS,
  VISUAL_ANNOTATION_TARGET_MESSAGE_TYPE,
} from './visual-annotation-types';

import type {
  MinimalVisualAnnotationAnchor,
  ResolveVisualAnnotationAnchorsMessage,
  SetAnnotationModeMessage,
  VisualAnnotationAncestorSummary,
  VisualAnnotationAnchorsResolvedMessage,
  VisualAnnotationComputedStyleField,
  VisualAnnotationInspectPayload,
  VisualAnnotationRect,
  VisualAnnotationRectRatio,
  VisualAnnotationResolvedAnchor,
  VisualAnnotationTargetMessage,
  VisualAnnotationViewport,
} from './visual-annotation-types';

export * from './visual-annotation-types';

export type VisualCommentInspectorOptions = {
  targetWindow?: Window;
  allowedParentOrigins?: string[];
  postMessageTargetOrigin?: string;
  preferSemanticTarget?: boolean;
  maxTextLength?: number;
  maxOuterHTMLLength?: number;
  maxAncestors?: number;
  includeComputedStyle?: boolean;
};

export type VisualCommentInspector = {
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  destroy(): void;
};

type NormalizedOptions = Required<
  Pick<
    VisualCommentInspectorOptions,
    | 'preferSemanticTarget'
    | 'maxTextLength'
    | 'maxOuterHTMLLength'
    | 'maxAncestors'
    | 'includeComputedStyle'
  >
> &
  Pick<VisualCommentInspectorOptions, 'allowedParentOrigins' | 'postMessageTargetOrigin'>;

const DEFAULT_TEXT_LENGTH = 240;
const DEFAULT_OUTER_HTML_LENGTH = 800;
const DEFAULT_MAX_ANCESTORS = 6;
const MAX_SEMANTIC_PARENT_DEPTH = 5;
const MAX_SELECTOR_DEPTH = 6;
const INTERACTION_LAYER_ATTRIBUTE = 'data-lody-visual-annotation-interaction-layer';

const LOW_SEMANTIC_TAGS = new Set([
  'b',
  'em',
  'i',
  'path',
  'small',
  'span',
  'strong',
  'svg',
  'use',
]);

const INTERACTIVE_SELECTOR =
  'button, a[href], input, textarea, select, label, summary, details, [role="button"]';

const TEXT_BLOCK_SELECTOR =
  'h1, h2, h3, h4, h5, h6, p, li, dt, dd, blockquote, figcaption, caption, legend, th, td, pre, code';

const TEXT_INLINE_TAGS = new Set([
  'abbr',
  'b',
  'code',
  'em',
  'i',
  'mark',
  'small',
  'span',
  'strong',
  'time',
]);

const SEMANTIC_ATTRIBUTE_SELECTOR =
  '[role], [aria-label], [aria-labelledby], [data-testid], [data-test], [data-cy]';

const SECTIONING_SELECTOR = 'form, nav, main, header, footer, section, article';

const ATTRIBUTE_ALLOWLIST = [
  'id',
  'class',
  'role',
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'title',
  'alt',
  'name',
  'type',
  'placeholder',
  'value',
  'href',
  'src',
  'data-testid',
  'data-test',
  'data-cy',
] as const;

const STABLE_SELECTOR_ATTRIBUTES = [
  'data-testid',
  'data-test',
  'data-cy',
  'aria-label',
  'name',
] as const;

const ANCHOR_ATTRIBUTES = [...STABLE_SELECTOR_ATTRIBUTES, 'role', 'type', 'href'] as const;

export const createVisualCommentInspector = (
  options: VisualCommentInspectorOptions = {}
): VisualCommentInspector => {
  const runtimeWindow = options.targetWindow ?? getRuntimeWindow();
  const runtimeDocument = runtimeWindow.document;
  const normalized = normalizeOptions(options);
  let enabled = false;
  let destroyed = false;
  let overlay: HTMLDivElement | undefined;
  let interactionLayer: HTMLDivElement | undefined;
  let currentHoverTarget: Element | undefined;
  let trackedAnchors: ResolveVisualAnnotationAnchorsMessage['payload']['anchors'] = [];
  let trackedAnchorListenersAttached = false;
  let trackedAnchorFrame: number | undefined;
  let trackedAnchorMutationObserver: MutationObserver | undefined;
  let warnedMissingAllowedParentOrigins = false;
  let warnedMissingPostMessageTargetOrigin = false;

  const warnOnce = (message: string, key: 'allowedParentOrigins' | 'postMessageTargetOrigin') => {
    if (key === 'allowedParentOrigins') {
      if (warnedMissingAllowedParentOrigins) {
        return;
      }
      warnedMissingAllowedParentOrigins = true;
    } else {
      if (warnedMissingPostMessageTargetOrigin) {
        return;
      }
      warnedMissingPostMessageTargetOrigin = true;
    }
    globalThis.console.warn(`[Lody visual annotation] ${message}`);
  };

  const hideOverlay = () => {
    if (overlay) {
      overlay.style.display = 'none';
    }
  };

  const hideInteractionLayer = () => {
    interactionLayer?.style.setProperty('display', 'none', 'important');
    interactionLayer?.style.setProperty('pointer-events', 'none', 'important');
  };

  const getInteractionLayer = () => {
    if (interactionLayer?.isConnected) {
      interactionLayer.style.setProperty('display', 'block', 'important');
      interactionLayer.style.setProperty('pointer-events', 'auto', 'important');
      return interactionLayer;
    }
    const next = runtimeDocument.createElement('div');
    next.setAttribute(INTERACTION_LAYER_ATTRIBUTE, 'true');
    next.setAttribute('aria-hidden', 'true');
    next.style.setProperty('position', 'fixed', 'important');
    next.style.setProperty('top', '0', 'important');
    next.style.setProperty('right', '0', 'important');
    next.style.setProperty('bottom', '0', 'important');
    next.style.setProperty('left', '0', 'important');
    next.style.setProperty('display', 'block', 'important');
    next.style.setProperty('pointer-events', 'auto', 'important');
    next.style.setProperty('background', 'transparent', 'important');
    next.style.setProperty('cursor', 'crosshair', 'important');
    next.style.setProperty('z-index', '2147483647', 'important');
    (runtimeDocument.body ?? runtimeDocument.documentElement).appendChild(next);
    interactionLayer = next;
    return next;
  };

  const getOverlay = () => {
    if (overlay) {
      return overlay;
    }
    const next = runtimeDocument.createElement('div');
    next.setAttribute('data-lody-visual-annotation-overlay', 'true');
    next.style.position = 'fixed';
    next.style.top = '0';
    next.style.left = '0';
    next.style.pointerEvents = 'none';
    next.style.boxSizing = 'border-box';
    next.style.border = '2px solid rgba(37, 99, 235, 0.9)';
    next.style.background = 'rgba(37, 99, 235, 0.08)';
    next.style.borderRadius = '4px';
    next.style.zIndex = '2147483647';
    next.style.transition = 'transform 80ms ease, width 80ms ease, height 80ms ease';
    next.style.display = 'none';
    (runtimeDocument.body ?? runtimeDocument.documentElement).appendChild(next);
    overlay = next;
    return next;
  };

  const updateOverlayForTarget = (target: Element | undefined) => {
    currentHoverTarget = target;
    if (!enabled || !target) {
      hideOverlay();
      return;
    }
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      hideOverlay();
      return;
    }
    const currentOverlay = getOverlay();
    currentOverlay.style.display = 'block';
    currentOverlay.style.transform = `translate(${round(rect.left)}px, ${round(rect.top)}px)`;
    currentOverlay.style.width = `${round(rect.width)}px`;
    currentOverlay.style.height = `${round(rect.height)}px`;
  };

  const findTargetAtPoint = (clientX: number, clientY: number) => {
    interactionLayer?.style.setProperty('pointer-events', 'none', 'important');
    let rawTarget: Element | null;
    try {
      rawTarget = runtimeDocument.elementFromPoint(clientX, clientY);
    } finally {
      if (interactionLayer && enabled) {
        interactionLayer.style.setProperty('pointer-events', 'auto', 'important');
      }
    }
    if (!rawTarget || isInspectorOverlay(rawTarget)) {
      return undefined;
    }
    return normalized.preferSemanticTarget ? findSemanticTarget(rawTarget) : rawTarget;
  };

  const handlePointerMove = (event: MouseEvent) => {
    if (!enabled) {
      return;
    }
    const target = findTargetAtPoint(event.clientX, event.clientY);
    // Skip if hovering the same element — viewport change handler covers scroll/resize rect drift.
    if (target === currentHoverTarget) {
      return;
    }
    updateOverlayForTarget(target);
  };

  const handleViewportChange = () => {
    if (!enabled) {
      return;
    }
    updateOverlayForTarget(currentHoverTarget);
  };

  const postResolvedAnchors = () => {
    trackedAnchorFrame = undefined;
    if (destroyed || trackedAnchors.length === 0) {
      return;
    }
    if (normalized.postMessageTargetOrigin === undefined) {
      warnOnce(
        'Refusing to post resolved anchors because postMessageTargetOrigin is not configured.',
        'postMessageTargetOrigin'
      );
      return;
    }
    const payload: VisualAnnotationAnchorsResolvedMessage['payload'] = {
      viewport: getViewport(runtimeWindow),
      results: trackedAnchors.map(({ commentId, anchor }) =>
        resolveAnchor(commentId, anchor, runtimeDocument, runtimeWindow)
      ),
    };
    runtimeWindow.parent.postMessage(
      {
        type: VISUAL_ANNOTATION_ANCHORS_RESOLVED_MESSAGE_TYPE,
        payload,
      } satisfies VisualAnnotationAnchorsResolvedMessage,
      normalized.postMessageTargetOrigin
    );
  };

  const scheduleResolvedAnchorsPost = () => {
    if (destroyed || trackedAnchors.length === 0 || trackedAnchorFrame !== undefined) {
      return;
    }
    trackedAnchorFrame = requestAnimationFrameForWindow(runtimeWindow, postResolvedAnchors);
  };

  const handleTrackedAnchorViewportChange = () => {
    scheduleResolvedAnchorsPost();
  };

  const attachTrackedAnchorListeners = () => {
    if (trackedAnchorListenersAttached) {
      return;
    }
    trackedAnchorListenersAttached = true;
    runtimeWindow.addEventListener('scroll', handleTrackedAnchorViewportChange, {
      capture: true,
      passive: true,
    });
    runtimeWindow.addEventListener('resize', handleTrackedAnchorViewportChange);
    const mutationObserverCtor = (
      runtimeWindow as unknown as {
        MutationObserver?: new (callback: () => void) => MutationObserver;
      }
    ).MutationObserver;
    if (typeof mutationObserverCtor === 'function') {
      const mutationObserver = new mutationObserverCtor(() => {
        scheduleResolvedAnchorsPost();
      });
      trackedAnchorMutationObserver = mutationObserver;
      mutationObserver.observe(runtimeDocument.documentElement, {
        attributes: true,
        childList: true,
        subtree: true,
      });
    }
  };

  const detachTrackedAnchorListeners = () => {
    if (!trackedAnchorListenersAttached) {
      return;
    }
    trackedAnchorListenersAttached = false;
    runtimeWindow.removeEventListener('scroll', handleTrackedAnchorViewportChange, {
      capture: true,
    });
    runtimeWindow.removeEventListener('resize', handleTrackedAnchorViewportChange);
    trackedAnchorMutationObserver?.disconnect();
    trackedAnchorMutationObserver = undefined;
    if (trackedAnchorFrame !== undefined) {
      cancelAnimationFrameForWindow(runtimeWindow, trackedAnchorFrame);
      trackedAnchorFrame = undefined;
    }
  };

  const setTrackedAnchors = (
    anchors: ResolveVisualAnnotationAnchorsMessage['payload']['anchors']
  ) => {
    trackedAnchors = anchors;
    if (trackedAnchors.length === 0) {
      detachTrackedAnchorListeners();
      return;
    }
    attachTrackedAnchorListeners();
    postResolvedAnchors();
  };

  const handleClick = (event: MouseEvent) => {
    if (!enabled) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const target = findTargetAtPoint(event.clientX, event.clientY);
    if (!target) {
      return;
    }
    if (normalized.postMessageTargetOrigin === undefined) {
      warnOnce(
        'Refusing to post inspect payload because postMessageTargetOrigin is not configured.',
        'postMessageTargetOrigin'
      );
      return;
    }
    const payload = buildPayload(target, event, normalized);
    runtimeWindow.parent.postMessage(
      {
        type: VISUAL_ANNOTATION_TARGET_MESSAGE_TYPE,
        payload,
      } satisfies VisualAnnotationTargetMessage,
      normalized.postMessageTargetOrigin
    );
  };

  const addModeListeners = () => {
    runtimeDocument.addEventListener('click', handleClick, { capture: true, passive: false });
    // pointermove fires alongside mousemove for mouse input; mousemove alone covers the inspector
    // use case and avoids double work per move. Touch/pen inspection isn't a target surface here.
    runtimeDocument.addEventListener('mousemove', handlePointerMove, { capture: true });
    runtimeWindow.addEventListener('scroll', handleViewportChange, {
      capture: true,
      passive: true,
    });
    runtimeWindow.addEventListener('resize', handleViewportChange);
  };

  const removeModeListeners = () => {
    runtimeDocument.removeEventListener('click', handleClick, { capture: true });
    runtimeDocument.removeEventListener('mousemove', handlePointerMove, { capture: true });
    runtimeWindow.removeEventListener('scroll', handleViewportChange, { capture: true });
    runtimeWindow.removeEventListener('resize', handleViewportChange);
  };

  const setEnabled = (nextEnabled: boolean) => {
    if (destroyed || enabled === nextEnabled) {
      return;
    }
    enabled = nextEnabled;
    if (enabled) {
      getInteractionLayer();
      addModeListeners();
      return;
    }
    removeModeListeners();
    hideInteractionLayer();
    currentHoverTarget = undefined;
    hideOverlay();
  };

  const handleMessage = (event: MessageEvent<unknown>) => {
    if (destroyed || event.source !== runtimeWindow.parent) {
      return;
    }
    if (!normalized.allowedParentOrigins) {
      warnOnce(
        'Ignoring annotation mode message because allowedParentOrigins is not configured.',
        'allowedParentOrigins'
      );
      return;
    }
    if (!normalized.allowedParentOrigins.includes(event.origin)) {
      return;
    }
    const data = event.data;
    if (isSetAnnotationModeMessage(data)) {
      setEnabled(data.enabled);
      return;
    }
    if (isResolveVisualAnnotationAnchorsMessage(data)) {
      setTrackedAnchors(data.payload.anchors);
    }
  };

  runtimeWindow.addEventListener('message', handleMessage);

  return {
    setEnabled,
    isEnabled() {
      return enabled;
    },
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      if (enabled) {
        removeModeListeners();
      }
      runtimeWindow.removeEventListener('message', handleMessage);
      detachTrackedAnchorListeners();
      trackedAnchors = [];
      overlay?.remove();
      overlay = undefined;
      interactionLayer?.remove();
      interactionLayer = undefined;
      currentHoverTarget = undefined;
      enabled = false;
    },
  };
};

export const createVisualAnnotationInspectPayload = (
  target: Element,
  event: Pick<MouseEvent, 'clientX' | 'clientY' | 'pageX' | 'pageY'>,
  options: VisualCommentInspectorOptions = {}
): VisualAnnotationInspectPayload => buildPayload(target, event, normalizeOptions(options));

const buildPayload = (
  target: Element,
  event: Pick<MouseEvent, 'clientX' | 'clientY' | 'pageX' | 'pageY'>,
  normalized: NormalizedOptions
): VisualAnnotationInspectPayload => {
  const runtimeWindow = target.ownerDocument.defaultView ?? getRuntimeWindow();
  const runtimeDocument = target.ownerDocument;
  const rect = toVisualAnnotationRect(target.getBoundingClientRect());
  const attributes = getImportantAttributes(target, normalized.maxTextLength);
  const text = summarizeElementText(target, normalized.maxTextLength);
  const className = summarizeClassName(target, normalized.maxTextLength);
  const role = getAttributeIfPresent(target, 'role');

  return {
    page: {
      url: `${runtimeWindow.location.pathname}${runtimeWindow.location.search}${runtimeWindow.location.hash}`,
      pathname: runtimeWindow.location.pathname,
      title: runtimeDocument.title,
      viewport: getViewport(runtimeWindow),
    },
    click: {
      clientX: round(event.clientX),
      clientY: round(event.clientY),
      pageX: round(event.pageX),
      pageY: round(event.pageY),
    },
    target: {
      tag: getTag(target),
      ...(isNonEmptyString(target.id) ? { id: target.id } : {}),
      ...(isNonEmptyString(className) ? { className } : {}),
      ...(isNonEmptyString(role) ? { role } : {}),
      attributes,
      ...(isNonEmptyString(text) ? { text } : {}),
      rect,
      selector: buildStableSelector(target),
      xpath: buildXPath(target),
      outerHTMLPreview: summarizeOuterHTML(target, normalized.maxOuterHTMLLength),
    },
    ancestors: getAncestorSummaries(target, normalized),
    nearbyText: getNearbyText(target, normalized.maxTextLength),
    style: normalized.includeComputedStyle ? getComputedStyleSummary(target) : emptyStyleSummary(),
  };
};

export const createMinimalVisualAnnotationAnchor = (
  payload: VisualAnnotationInspectPayload
): MinimalVisualAnnotationAnchor => {
  const { viewport } = payload.page;
  const nearbyText = [
    payload.nearbyText.self,
    payload.nearbyText.parentSummary,
    ...(payload.nearbyText.siblingTexts ?? []),
  ].filter(isNonEmptyString);

  return {
    version: 1,
    page: {
      url: payload.page.url,
      pathname: payload.page.pathname,
      viewport,
    },
    click: {
      ...payload.click,
      viewportXRatio: ratio(payload.click.clientX, viewport.width),
      viewportYRatio: ratio(payload.click.clientY, viewport.height),
    },
    target: {
      tag: payload.target.tag,
      ...(isNonEmptyString(payload.target.id) ? { id: payload.target.id } : {}),
      ...(isNonEmptyString(payload.target.role) ? { role: payload.target.role } : {}),
      attributes: pickAnchorAttributes(payload.target.attributes),
      ...(isNonEmptyString(payload.target.text) ? { text: payload.target.text } : {}),
      rect: {
        x: payload.target.rect.x,
        y: payload.target.rect.y,
        width: payload.target.rect.width,
        height: payload.target.rect.height,
      },
      rectRatio: {
        x: ratio(payload.target.rect.x, viewport.width),
        y: ratio(payload.target.rect.y, viewport.height),
        width: ratio(payload.target.rect.width, viewport.width),
        height: ratio(payload.target.rect.height, viewport.height),
      },
      selector: payload.target.selector,
      ...(payload.target.xpath ? { xpath: payload.target.xpath } : {}),
    },
    context: {
      ancestors: payload.ancestors.map((ancestor) => ({
        tag: ancestor.tag,
        ...(isNonEmptyString(ancestor.id) ? { id: ancestor.id } : {}),
        ...(isNonEmptyString(ancestor.role) ? { role: ancestor.role } : {}),
        ...(isNonEmptyString(ancestor.selector) ? { selector: ancestor.selector } : {}),
        ...(isNonEmptyString(ancestor.text) ? { text: ancestor.text } : {}),
      })),
      ...(nearbyText.length > 0 ? { nearbyText } : {}),
    },
  };
};

export const findSemanticTarget = (rawTarget: Element): Element => {
  const candidates = collectSelfAndParents(rawTarget, MAX_SEMANTIC_PARENT_DEPTH);
  const interactive = candidates.find((candidate) => safeMatches(candidate, INTERACTIVE_SELECTOR));
  if (interactive) {
    return interactive;
  }

  // Text blocks (h1-h6, p, li, …) are picked before [data-testid]/section ancestors so a
  // copy review anchors at the heading instead of the marketing section. Rejected: always
  // promoting to the nearest [data-testid] — makes text reviews coarse and loses the line.
  const textBlock = candidates.find((candidate) => safeMatches(candidate, TEXT_BLOCK_SELECTOR));
  if (textBlock) {
    return textBlock;
  }

  const inlineText = candidates.find(isInlineTextTarget);
  if (inlineText) {
    return inlineText;
  }

  if (isHighSignalElement(rawTarget)) {
    return rawTarget;
  }

  const attributed = candidates.find((candidate) =>
    safeMatches(candidate, SEMANTIC_ATTRIBUTE_SELECTOR)
  );
  if (attributed) {
    return attributed;
  }
  const sectioning = candidates.find((candidate) => safeMatches(candidate, SECTIONING_SELECTOR));
  return sectioning ?? rawTarget;
};

export const buildStableSelector = (element: Element): string => {
  const doc = element.ownerDocument;
  if (element.id) {
    const idSelector = `#${escapeCssIdent(element.id)}`;
    if (querySelectorContainsOnly(doc, idSelector, element)) {
      return idSelector;
    }
  }

  const segments: string[] = [];
  let current: Element | null = element;
  let depth = 0;
  while (current && current.nodeType === current.ELEMENT_NODE && depth < MAX_SELECTOR_DEPTH) {
    segments.unshift(buildSelectorSegment(current));
    const selector = segments.join(' > ');
    if (querySelectorContainsOnly(doc, selector, element)) {
      return selector;
    }
    current = current.parentElement;
    depth += 1;
  }
  return segments.join(' > ') || getTag(element);
};

export const buildXPath = (element: Element): string => {
  if (element.id) {
    return `//*[@id=${xpathLiteral(element.id)}]`;
  }
  const segments: string[] = [];
  let current: Element | null = element;
  while (current) {
    const tag = getTag(current);
    const index = getElementIndexOfType(current);
    segments.unshift(`${tag}[${index}]`);
    current = current.parentElement;
  }
  return `/${segments.join('/')}`;
};

const resolveAnchor = (
  commentId: string,
  anchor: MinimalVisualAnnotationAnchor,
  runtimeDocument: Document,
  runtimeWindow: Window
): VisualAnnotationResolvedAnchor => {
  const element = findElementForAnchor(anchor, runtimeDocument);
  if (!element) {
    return { commentId, resolved: false };
  }
  const rect = toVisualAnnotationRect(element.getBoundingClientRect());
  if (rect.width <= 0 || rect.height <= 0) {
    return { commentId, resolved: false };
  }
  return {
    commentId,
    resolved: true,
    rect,
    rectRatio: toRectRatio(rect, getViewport(runtimeWindow)),
    selector: buildStableSelector(element),
    xpath: buildXPath(element),
  };
};

const findElementForAnchor = (
  anchor: MinimalVisualAnnotationAnchor,
  runtimeDocument: Document
): Element | undefined =>
  querySelector(runtimeDocument, anchor.target.selector) ??
  querySelectorById(runtimeDocument, anchor.target.id) ??
  evaluateXPath(runtimeDocument, anchor.target.xpath) ??
  findElementByAnchorText(runtimeDocument, anchor);

const querySelector = (runtimeDocument: Document, selector: string): Element | undefined => {
  try {
    return runtimeDocument.querySelector(selector) ?? undefined;
  } catch {
    return undefined;
  }
};

const querySelectorById = (
  runtimeDocument: Document,
  id: string | undefined
): Element | undefined =>
  isNonEmptyString(id) ? (runtimeDocument.getElementById(id) ?? undefined) : undefined;

const evaluateXPath = (
  runtimeDocument: Document,
  xpath: string | undefined
): Element | undefined => {
  if (!isNonEmptyString(xpath) || typeof runtimeDocument.evaluate !== 'function') {
    return undefined;
  }
  const resultType = runtimeDocument.defaultView?.XPathResult?.FIRST_ORDERED_NODE_TYPE ?? 9;
  try {
    const result = runtimeDocument.evaluate(xpath, runtimeDocument, null, resultType, null);
    const node = result.singleNodeValue;
    return node?.nodeType === 1 ? (node as Element) : undefined;
  } catch {
    return undefined;
  }
};

const findElementByAnchorText = (
  runtimeDocument: Document,
  anchor: MinimalVisualAnnotationAnchor
): Element | undefined => {
  if (!isNonEmptyString(anchor.target.text)) {
    return undefined;
  }
  const expectedText = normalizeWhitespace(anchor.target.text);
  const candidates = Array.from(runtimeDocument.querySelectorAll(anchor.target.tag));
  return candidates.find((candidate) => {
    const text = summarizeElementText(candidate, expectedText.length + 40);
    return isNonEmptyString(text) && normalizeWhitespace(text).includes(expectedText);
  });
};

const toRectRatio = (
  rect: Pick<VisualAnnotationRect, 'x' | 'y' | 'width' | 'height'>,
  viewport: VisualAnnotationViewport
): VisualAnnotationRectRatio => ({
  x: ratio(rect.x, viewport.width),
  y: ratio(rect.y, viewport.height),
  width: ratio(rect.width, viewport.width),
  height: ratio(rect.height, viewport.height),
});

const requestAnimationFrameForWindow = (runtimeWindow: Window, callback: () => void): number => {
  if (typeof runtimeWindow.requestAnimationFrame === 'function') {
    return runtimeWindow.requestAnimationFrame(callback);
  }
  return runtimeWindow.setTimeout(callback, 16);
};

const cancelAnimationFrameForWindow = (runtimeWindow: Window, frame: number) => {
  if (typeof runtimeWindow.cancelAnimationFrame === 'function') {
    runtimeWindow.cancelAnimationFrame(frame);
    return;
  }
  runtimeWindow.clearTimeout(frame);
};

const getRuntimeWindow = (): Window => {
  if (typeof window === 'undefined') {
    throw new Error('Visual comment inspector requires a browser window.');
  }
  return window;
};

const normalizeOptions = (options: VisualCommentInspectorOptions): NormalizedOptions => ({
  allowedParentOrigins: options.allowedParentOrigins,
  postMessageTargetOrigin: options.postMessageTargetOrigin,
  preferSemanticTarget: options.preferSemanticTarget ?? true,
  maxTextLength: options.maxTextLength ?? DEFAULT_TEXT_LENGTH,
  maxOuterHTMLLength: options.maxOuterHTMLLength ?? DEFAULT_OUTER_HTML_LENGTH,
  maxAncestors: options.maxAncestors ?? DEFAULT_MAX_ANCESTORS,
  includeComputedStyle: options.includeComputedStyle ?? true,
});

const isSetAnnotationModeMessage = (value: unknown): value is SetAnnotationModeMessage => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const maybe = value as { type?: unknown; enabled?: unknown };
  return maybe.type === SET_ANNOTATION_MODE_MESSAGE_TYPE && typeof maybe.enabled === 'boolean';
};

const isResolveVisualAnnotationAnchorsMessage = (
  value: unknown
): value is ResolveVisualAnnotationAnchorsMessage => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const maybe = value as { type?: unknown; payload?: { anchors?: unknown } };
  return (
    maybe.type === RESOLVE_VISUAL_ANNOTATION_ANCHORS_MESSAGE_TYPE &&
    typeof maybe.payload === 'object' &&
    maybe.payload !== null &&
    Array.isArray(maybe.payload.anchors) &&
    maybe.payload.anchors.every(isResolveAnchorInput)
  );
};

const isResolveAnchorInput = (
  value: unknown
): value is ResolveVisualAnnotationAnchorsMessage['payload']['anchors'][number] => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const maybe = value as { commentId?: unknown; anchor?: unknown };
  return typeof maybe.commentId === 'string' && isMinimalAnchorLike(maybe.anchor);
};

const isMinimalAnchorLike = (value: unknown): value is MinimalVisualAnnotationAnchor => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const maybe = value as {
    version?: unknown;
    page?: unknown;
    click?: unknown;
    target?: { selector?: unknown; tag?: unknown; rectRatio?: unknown };
    context?: unknown;
  };
  return (
    maybe.version === 1 &&
    typeof maybe.page === 'object' &&
    maybe.page !== null &&
    typeof maybe.click === 'object' &&
    maybe.click !== null &&
    typeof maybe.target === 'object' &&
    maybe.target !== null &&
    typeof maybe.target.selector === 'string' &&
    typeof maybe.target.tag === 'string' &&
    typeof maybe.target.rectRatio === 'object' &&
    maybe.target.rectRatio !== null &&
    typeof maybe.context === 'object' &&
    maybe.context !== null
  );
};

const isInspectorOverlay = (element: Element): boolean =>
  element.closest(
    `[data-lody-visual-annotation-overlay="true"], [${INTERACTION_LAYER_ATTRIBUTE}="true"]`
  ) !== null;

const isHighSignalElement = (element: Element): boolean => {
  const tag = getTag(element);
  if (LOW_SEMANTIC_TAGS.has(tag)) {
    return false;
  }
  return (
    safeMatches(element, INTERACTIVE_SELECTOR) ||
    safeMatches(element, SEMANTIC_ATTRIBUTE_SELECTOR) ||
    safeMatches(element, SECTIONING_SELECTOR)
  );
};

const isInlineTextTarget = (element: Element): boolean => {
  if (!TEXT_INLINE_TAGS.has(getTag(element))) {
    return false;
  }
  return isNonEmptyString(element.textContent);
};

const safeMatches = (element: Element, selector: string): boolean => {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
};

const collectSelfAndParents = (element: Element, maxParents: number): Element[] => {
  const elements: Element[] = [];
  let current: Element | null = element;
  for (let depth = 0; current && depth <= maxParents; depth += 1) {
    elements.push(current);
    current = current.parentElement;
  }
  return elements;
};

const getViewport = (runtimeWindow: Window): VisualAnnotationViewport => ({
  width: runtimeWindow.innerWidth,
  height: runtimeWindow.innerHeight,
  scrollX: runtimeWindow.scrollX,
  scrollY: runtimeWindow.scrollY,
  devicePixelRatio: runtimeWindow.devicePixelRatio,
});

const toVisualAnnotationRect = (rect: DOMRect): VisualAnnotationRect => ({
  x: round(rect.x),
  y: round(rect.y),
  width: round(rect.width),
  height: round(rect.height),
  top: round(rect.top),
  left: round(rect.left),
  right: round(rect.right),
  bottom: round(rect.bottom),
});

const getImportantAttributes = (element: Element, maxLength: number): Record<string, string> => {
  const attributes: Record<string, string> = {};
  for (const name of ATTRIBUTE_ALLOWLIST) {
    if (name === 'value' && !canCollectValueAttribute(element)) {
      continue;
    }
    const value = element.getAttribute(name);
    if (isNonEmptyString(value)) {
      attributes[name] = truncate(normalizeWhitespace(value), maxLength);
    }
  }
  return attributes;
};

const canCollectValueAttribute = (element: Element): boolean => {
  if (!isInputElement(element) && !isTextAreaElement(element)) {
    return false;
  }
  if (isTextAreaElement(element)) {
    return true;
  }
  const type = element.type.toLowerCase();
  return type !== 'password' && type !== 'hidden';
};

const summarizeElementText = (element: Element, maxLength: number): string | undefined => {
  const tag = getTag(element);
  if (tag === 'script' || tag === 'style' || tag === 'noscript') {
    return undefined;
  }
  if (isInputElement(element) || isTextAreaElement(element)) {
    if (!canCollectValueAttribute(element)) {
      return undefined;
    }
    return summarizeText(
      element.value || element.placeholder || element.getAttribute('aria-label'),
      maxLength
    );
  }
  // innerText forces layout; try it first when available, fall back lazily to avoid extra
  // attribute reads + summarize() calls when innerText already produced a result.
  if (isHtmlElement(element)) {
    const fromInnerText = summarizeText(element.innerText, maxLength);
    if (fromInnerText !== undefined) {
      return fromInnerText;
    }
  }
  return (
    summarizeText(element.textContent, maxLength) ??
    summarizeText(element.getAttribute('aria-label'), maxLength) ??
    summarizeText(element.getAttribute('title'), maxLength) ??
    summarizeText(element.getAttribute('alt'), maxLength)
  );
};

const isInputElement = (element: Element): element is HTMLInputElement => {
  return getTag(element) === 'input' && 'type' in element && 'value' in element;
};

const isTextAreaElement = (element: Element): element is HTMLTextAreaElement => {
  return getTag(element) === 'textarea' && 'value' in element;
};

type ElementWithInnerText = Element & { innerText: string };

const isHtmlElement = (element: Element): element is ElementWithInnerText => {
  return 'innerText' in element && typeof element.innerText === 'string';
};

const summarizeText = (value: string | null | undefined, maxLength: number): string | undefined => {
  if (!isNonEmptyString(value)) {
    return undefined;
  }
  const normalized = normalizeWhitespace(value);
  return normalized.length > 0 ? truncate(normalized, maxLength) : undefined;
};

const summarizeClassName = (element: Element, maxLength: number): string | undefined => {
  const className =
    typeof element.className === 'string'
      ? element.className
      : (element.getAttribute('class') ?? undefined);
  return summarizeText(className, maxLength);
};

const summarizeOuterHTML = (element: Element, maxLength: number): string => {
  const tag = getTag(element);
  if (tag === 'script' || tag === 'style' || tag === 'noscript') {
    return `<${tag}>`;
  }
  const clone = element.cloneNode(true);
  if (isElementNode(clone)) {
    redactFormValuesForOuterHTMLPreview(clone);
    return truncate(normalizeWhitespace(clone.outerHTML), maxLength);
  }
  return truncate(normalizeWhitespace(element.outerHTML), maxLength);
};

const isElementNode = (node: Node): node is Element => node.nodeType === 1;

const redactFormValuesForOuterHTMLPreview = (root: Element) => {
  const candidates = [root, ...Array.from(root.querySelectorAll('input, textarea, option'))];
  for (const candidate of candidates) {
    const tag = getTag(candidate);
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'option') {
      continue;
    }
    candidate.removeAttribute('value');
    if (tag === 'textarea') {
      candidate.textContent = '';
    }
  }
};

const getNearbyText = (
  element: Element,
  maxLength: number
): VisualAnnotationInspectPayload['nearbyText'] => {
  const siblingTexts: string[] = [];
  const siblings = getNearbySiblings(element);
  for (const sibling of siblings) {
    const text = summarizeElementText(sibling, Math.floor(maxLength / 2));
    if (isNonEmptyString(text)) {
      siblingTexts.push(text);
    }
  }
  const self = summarizeElementText(element, maxLength);
  const parentSummary =
    element.parentElement !== null
      ? summarizeElementText(element.parentElement, maxLength)
      : undefined;
  return {
    ...(isNonEmptyString(self) ? { self } : {}),
    ...(isNonEmptyString(parentSummary) ? { parentSummary } : {}),
    ...(siblingTexts.length > 0 ? { siblingTexts } : {}),
  };
};

const getNearbySiblings = (element: Element): Element[] => {
  const siblings: Element[] = [];
  let previous = element.previousElementSibling;
  while (previous && siblings.length < 2) {
    siblings.unshift(previous);
    previous = previous.previousElementSibling;
  }
  let next = element.nextElementSibling;
  while (next && siblings.length < 4) {
    siblings.push(next);
    next = next.nextElementSibling;
  }
  return siblings;
};

const getAncestorSummaries = (
  element: Element,
  options: NormalizedOptions
): VisualAnnotationAncestorSummary[] => {
  const ancestors: VisualAnnotationAncestorSummary[] = [];
  let current = element.parentElement;
  while (current && ancestors.length < options.maxAncestors) {
    const text = summarizeElementText(current, Math.floor(options.maxTextLength / 2));
    const className = summarizeClassName(current, options.maxTextLength);
    const role = getAttributeIfPresent(current, 'role');
    ancestors.push({
      tag: getTag(current),
      ...(isNonEmptyString(current.id) ? { id: current.id } : {}),
      ...(isNonEmptyString(className) ? { className } : {}),
      ...(isNonEmptyString(role) ? { role } : {}),
      ...(isNonEmptyString(text) ? { text } : {}),
      selector: buildStableSelector(current),
      attributes: getImportantAttributes(current, options.maxTextLength),
    });
    current = current.parentElement;
  }
  return ancestors;
};

const getComputedStyleSummary = (
  element: Element
): Record<VisualAnnotationComputedStyleField, string> => {
  const view = element.ownerDocument.defaultView;
  const computed = view?.getComputedStyle(element);
  const summary = emptyStyleSummary();
  if (!computed) {
    return summary;
  }
  for (const field of VISUAL_ANNOTATION_STYLE_FIELDS) {
    summary[field] = computed[field];
  }
  return summary;
};

const emptyStyleSummary = (): Record<VisualAnnotationComputedStyleField, string> => ({
  display: '',
  position: '',
  width: '',
  height: '',
  margin: '',
  padding: '',
  gap: '',
  color: '',
  backgroundColor: '',
  fontSize: '',
  fontWeight: '',
  lineHeight: '',
  border: '',
  borderRadius: '',
  opacity: '',
  visibility: '',
  overflow: '',
  zIndex: '',
});

const buildSelectorSegment = (element: Element): string => {
  const tag = getTag(element);
  for (const attr of STABLE_SELECTOR_ATTRIBUTES) {
    const value = element.getAttribute(attr);
    if (isNonEmptyString(value)) {
      return `${tag}[${attr}="${escapeCssString(value)}"]`;
    }
  }
  const stableClasses = getStableClasses(element).slice(0, 2);
  const base =
    stableClasses.length > 0
      ? `${tag}${stableClasses.map((className) => `.${escapeCssIdent(className)}`).join('')}`
      : tag;
  const parent = element.parentElement;
  if (!parent) {
    return base;
  }
  const sameTagSiblings = Array.from(parent.children).filter((child) => getTag(child) === tag);
  return sameTagSiblings.length > 1
    ? `${base}:nth-of-type(${getElementIndexOfType(element)})`
    : base;
};

const getStableClasses = (element: Element): string[] => {
  const className =
    typeof element.className === 'string'
      ? element.className
      : (element.getAttribute('class') ?? '');
  return className
    .split(/\s+/g)
    .map((value) => value.trim())
    .filter((value) => isStableClassName(value));
};

const isStableClassName = (value: string): boolean => {
  if (value.length < 3) {
    return false;
  }
  if (/[:[\]/\\]/.test(value)) {
    return false;
  }
  if (/^(css|sc|_)[-_a-zA-Z0-9]*[0-9a-f]{5,}$/i.test(value)) {
    return false;
  }
  if (
    /^(w|h|p|m|px|py|mx|my|mt|mb|ml|mr|pt|pb|pl|pr|text|bg|gap|top|left|right|bottom)-/.test(value)
  ) {
    return false;
  }
  return true;
};

const querySelectorContainsOnly = (doc: Document, selector: string, element: Element): boolean => {
  try {
    const matches = Array.from(doc.querySelectorAll(selector));
    return matches.length === 1 && matches[0] === element;
  } catch {
    return false;
  }
};

const getElementIndexOfType = (element: Element): number => {
  const tag = getTag(element);
  let index = 1;
  let sibling = element.previousElementSibling;
  while (sibling) {
    if (getTag(sibling) === tag) {
      index += 1;
    }
    sibling = sibling.previousElementSibling;
  }
  return index;
};

const getTag = (element: Element): string => element.tagName.toLowerCase();

const getAttributeIfPresent = (element: Element, name: string): string | undefined => {
  const value = element.getAttribute(name);
  return isNonEmptyString(value) ? value : undefined;
};

const pickAnchorAttributes = (attributes: Record<string, string>): Record<string, string> => {
  const anchorAttributes: Record<string, string> = {};
  for (const name of ANCHOR_ATTRIBUTES) {
    const value = attributes[name];
    if (isNonEmptyString(value)) {
      anchorAttributes[name] = value;
    }
  }
  return anchorAttributes;
};

const escapeCssIdent = (value: string): string => {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
};

const escapeCssString = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

const xpathLiteral = (value: string): string => {
  if (!value.includes('"')) {
    return `"${value}"`;
  }
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  return `concat(${value
    .split('"')
    .map((part) => `"${part}"`)
    .join(", '\"', ")})`;
};

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const truncate = (value: string, maxLength: number): string =>
  value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 3))}...` : value;

const round = (value: number): number => Math.round(value * 100) / 100;

const ratio = (value: number, denominator: number): number =>
  denominator > 0 ? round(value / denominator) : 0;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
