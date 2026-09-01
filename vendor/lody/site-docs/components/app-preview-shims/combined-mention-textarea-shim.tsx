'use client';

import { forwardRef, type TextareaHTMLAttributes } from 'react';

type MentionRange = {
  value: string;
  start: number;
  end: number;
  kind?: string;
};

export interface CombinedMentionTextareaProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'onChange' | 'value'
> {
  value: string;
  onValueChange: (value: string) => void;
  containerClassName?: string;
  mentionSource?: unknown;
  availableCommands?: unknown[];
  skillAgent?: unknown;
  skillMentionPlacement?: unknown;
  mentionSurface?: unknown;
  mentionValues?: string[];
  onMentionValuesChange?: (values: string[]) => void;
  label?: string;
  resetOnEmpty?: boolean;
  externalMentions?: MentionRange[];
  onExternalMentionsChange?: (mentions: MentionRange[]) => void;
  onMentionClick?: (mention: MentionRange) => void;
}

export const CombinedMentionTextarea = forwardRef<
  HTMLTextAreaElement,
  CombinedMentionTextareaProps
>(
  (
    {
      value,
      onValueChange,
      containerClassName,
      className,
      mentionSource: _mentionSource,
      availableCommands: _availableCommands,
      skillAgent: _skillAgent,
      skillMentionPlacement: _skillMentionPlacement,
      mentionSurface: _mentionSurface,
      mentionValues: _mentionValues,
      onMentionValuesChange: _onMentionValuesChange,
      label: _label,
      resetOnEmpty: _resetOnEmpty,
      externalMentions: _externalMentions,
      onExternalMentionsChange: _onExternalMentionsChange,
      onMentionClick: _onMentionClick,
      ...props
    },
    ref
  ) => {
    const textarea = (
      <textarea
        ref={ref}
        value={value}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        className={className}
        {...props}
      />
    );

    if (!containerClassName) {
      return textarea;
    }

    return <div className={containerClassName}>{textarea}</div>;
  }
);

CombinedMentionTextarea.displayName = 'CombinedMentionTextarea';
