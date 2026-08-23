import { DomainError } from "./errors.js";
export const CONTENT_LOCALE_UNRESOLVED = null;
export const canonicalizeLocale = (value) => {
    const normalized = value.trim();
    if (normalized.length === 0) {
        throw new DomainError("CONTENT_LOCALE_REQUIRED", "content_locale requires a concrete BCP 47 locale.");
    }
    if (normalized.toLowerCase() === "auto") {
        throw new DomainError("CONTENT_LOCALE_MUST_BE_CONCRETE", "content_locale cannot be auto; confirm a concrete BCP 47 locale with the user.", { contentLocale: value });
    }
    try {
        return Intl.getCanonicalLocales(normalized)[0];
    }
    catch {
        throw new DomainError("CONTENT_LOCALE_INVALID", "content_locale must be a valid BCP 47 locale.", { contentLocale: value });
    }
};
export const requireConcreteContentLocale = (value) => {
    if (value === null || value === undefined) {
        throw new DomainError("CONTENT_LOCALE_REQUIRED", "content_locale requires explicit user confirmation before project initialization.");
    }
    return canonicalizeLocale(value);
};
export const isChineseLocale = (locale) => locale.toLowerCase() === "zh" || locale.toLowerCase().startsWith("zh-");
