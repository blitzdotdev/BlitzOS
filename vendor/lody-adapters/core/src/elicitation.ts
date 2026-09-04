/**
 * Metadata for ACP form elicitation details that JSON Schema cannot express.
 * The same shape is used at request, property, and enum-option scope; consumers
 * read only the fields meaningful at that scope.
 */
export type LodyElicitationOption = {
  label: string;
  description?: string;
  preview?: string;
};

export type LodyElicitationQuestion = {
  id?: string;
  question: string;
  header: string;
  options: LodyElicitationOption[];
  multiSelect: boolean;
  allowCustomAnswer?: boolean;
  isSecret?: boolean;
};

export type LodyElicitationAnswer = string | string[];

export type LodyElicitationMeta = {
  version: 1;
  autoResolveAfterSeconds?: number | null;
  autoResolveAtEpochSeconds?: number;
  customAnswerFor?: string;
  secret?: boolean;
  preview?: string;
  questions?: LodyElicitationQuestion[];
  answers?: Record<string, LodyElicitationAnswer>;
};
