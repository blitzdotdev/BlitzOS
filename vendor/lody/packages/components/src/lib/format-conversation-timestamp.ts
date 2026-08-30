import { getServerNow } from '@lody/shared';

const DAY_IN_MS = 24 * 60 * 60 * 1000;

export interface FormatConversationTimestampOptions {
  locale?: string;
  now?: number | Date;
}

const getCalendarDay = (date: Date): number =>
  Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_IN_MS;

const getPreviousYearCutoffDay = (now: Date): number => {
  const previousYear = now.getFullYear() - 1;
  const lastDayOfMonth = new Date(previousYear, now.getMonth() + 1, 0).getDate();
  return (
    Date.UTC(previousYear, now.getMonth(), Math.min(now.getDate(), lastDayOfMonth)) / DAY_IN_MS
  );
};

const FORMAT_OPTIONS = {
  time: { hour: '2-digit', minute: '2-digit' },
  weekday: { weekday: 'long' },
  fullDate: { year: 'numeric', month: 'numeric', day: 'numeric' },
  monthDay: { month: 'numeric', day: 'numeric' },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

// Intl.DateTimeFormat is expensive to instantiate, and this formatter runs on
// the message render hot path. Cache one formatter per locale + kind.
const formatterCache = new Map<string, Intl.DateTimeFormat>();

const getFormatter = (
  locale: string | undefined,
  kind: keyof typeof FORMAT_OPTIONS
): Intl.DateTimeFormat => {
  const cacheKey = `${locale ?? ''}|${kind}`;
  let formatter = formatterCache.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, FORMAT_OPTIONS[kind]);
    formatterCache.set(cacheKey, formatter);
  }
  return formatter;
};

const formatDateAndTime = (
  date: Date,
  locale: string | undefined,
  kind: 'weekday' | 'fullDate' | 'monthDay'
): string =>
  `${getFormatter(locale, kind).format(date)} ${getFormatter(locale, 'time').format(date)}`;

export const formatConversationTimestamp = (
  timestamp: string | number | Date | null | undefined,
  { locale, now: nowValue = getServerNow() }: FormatConversationTimestampOptions = {}
): string => {
  if (timestamp === null || timestamp === undefined || timestamp === '') {
    return '';
  }

  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  if (Number.isNaN(date.getTime()) || Number.isNaN(now.getTime())) {
    return '';
  }

  const dateDay = getCalendarDay(date);
  const daysAgo = getCalendarDay(now) - dateDay;

  if (daysAgo === 0) {
    return getFormatter(locale, 'time').format(date);
  }

  if (daysAgo > 0 && daysAgo < 7) {
    return formatDateAndTime(date, locale, 'weekday');
  }

  if (dateDay <= getPreviousYearCutoffDay(now)) {
    return formatDateAndTime(date, locale, 'fullDate');
  }

  return formatDateAndTime(date, locale, 'monthDay');
};
