export type DiffTextChunkSide = 'old' | 'new';

export interface DiffTextChunkSource {
  readonly oldTextLength: number;
  readonly newTextLength: number;
  readonly readChunk: (input: {
    readonly side: DiffTextChunkSide;
    readonly startOffset: number;
    readonly endOffset: number;
  }) => Promise<string>;
  readonly dispose?: () => void;
}
