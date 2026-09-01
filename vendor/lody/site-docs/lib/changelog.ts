export type ChangelogLocale = 'en' | 'zh';

type ChangelogFrontmatter = {
  title: string;
  version: string;
  date?: string | Date;
  description?: string;
  draft?: boolean;
};

export type ChangelogSourceEntry = ChangelogFrontmatter & {
  info: {
    path: string;
  };
};

export type ChangelogEntry = Omit<ChangelogFrontmatter, 'date'> & {
  locale: ChangelogLocale;
  slug: string;
  date?: string;
  url: string;
  docPath: string;
};

function asDateString(value: string | Date | undefined): string | undefined {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (!value) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T\s].*)?$/u.exec(value);
  return match?.[1] ?? value;
}

function dateToTimestamp(date?: string): number {
  if (!date) return Number.NEGATIVE_INFINITY;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    return Date.UTC(year, month - 1, day);
  }

  const parsed = new Date(date).getTime();
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function getSlug(entry: ChangelogSourceEntry): string {
  const fileName = entry.info.path.split('/').pop() ?? entry.info.path;
  return fileName.replace(/\.(md|mdx)$/u, '');
}

export function normalizeChangelogEntries(
  locale: ChangelogLocale,
  entries: ChangelogSourceEntry[]
): ChangelogEntry[] {
  return entries
    .filter((entry) => entry.draft !== true)
    .map((entry): ChangelogEntry => {
      const slug = getSlug(entry);
      const date = asDateString(entry.date);

      return {
        title: entry.title,
        version: entry.version,
        description: entry.description,
        draft: entry.draft,
        locale,
        slug,
        date,
        url: locale === 'zh' ? `/zh/changelog/${slug}` : `/changelog/${slug}`,
        docPath: entry.info.path,
      };
    })
    .sort((a, b) => {
      const byDate = dateToTimestamp(b.date) - dateToTimestamp(a.date);
      if (byDate !== 0) return byDate;
      return b.version.localeCompare(a.version);
    });
}

export function formatChangelogDate(date: string | undefined, locale: ChangelogLocale) {
  if (!date) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (!match) return date;

  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: locale === 'zh' ? 'long' : 'short',
    day: 'numeric',
  }).format(parsed);
}
