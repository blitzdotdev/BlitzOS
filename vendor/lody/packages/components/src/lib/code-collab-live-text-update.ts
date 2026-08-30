export const RECENT_LOCAL_TEXT_ECHO_LIMIT = 32;

export class RecentLocalTextEchoTracker {
  private readonly keys = new Set<string>();
  private readonly queue: string[] = [];

  constructor(private readonly limit = RECENT_LOCAL_TEXT_ECHO_LIMIT) {}

  remember(text: string): void {
    const key = textEchoKey(text);
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.queue.push(key);
    while (this.queue.length > this.limit) {
      const evicted = this.queue.shift();
      if (evicted !== undefined) {
        this.keys.delete(evicted);
      }
    }
  }

  has(text: string): boolean {
    return this.keys.has(textEchoKey(text));
  }

  clear(): void {
    this.keys.clear();
    this.queue.length = 0;
  }
}

export type CodeCollabLiveTextUpdateDecision =
  | { readonly kind: 'ack-current'; readonly text: string }
  | { readonly kind: 'ignore-local-echo'; readonly text: string }
  | { readonly kind: 'external'; readonly text: string };

export function decideCodeCollabLiveTextUpdate(input: {
  readonly incomingText: string;
  readonly currentEditorText: string | undefined;
  readonly isRecentLocalEcho: boolean;
}): CodeCollabLiveTextUpdateDecision {
  if (input.currentEditorText === input.incomingText) {
    return { kind: 'ack-current', text: input.incomingText };
  }
  if (input.isRecentLocalEcho) {
    return { kind: 'ignore-local-echo', text: input.incomingText };
  }
  return { kind: 'external', text: input.incomingText };
}

function textEchoKey(text: string): string {
  return `${text.length}:${hashText(text).toString(36)}`;
}

function hashText(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
