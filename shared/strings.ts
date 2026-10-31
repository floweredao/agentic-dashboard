export type Locale = "en" | "ko";

/** Request-specific server locales and the browser's selected locale share the same paired-key contract. */
export function strings<T>(
  values: { readonly en: T; readonly ko: NoInfer<T> },
  selected: () => Locale = () => "en",
) {
  return (locale: Locale = selected()): T => values[locale];
}
