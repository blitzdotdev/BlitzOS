export const toIntlLocale = (language: string | null | undefined): string | undefined => {
  if (!language) {
    return undefined;
  }

  const normalizedLanguage = language.replace(/_/g, '-');

  try {
    return Intl.getCanonicalLocales(normalizedLanguage)[0];
  } catch {
    return undefined;
  }
};

/** Prefer the product language; fall back to English so OS locale never leaks units. */
export const toIntlLocaleOrEn = (language: string | null | undefined): string =>
  toIntlLocale(language) ?? 'en';
