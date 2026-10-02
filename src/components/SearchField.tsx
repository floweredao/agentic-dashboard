import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, CompositionEvent } from "react";
import { Search, X } from "lucide-react";
import { strings } from "../i18n";
import { useDashboard } from "../state";

const text = strings({
  en: { clear: "Clear search text" },
  ko: { clear: "검색어 지우기" },
});

/**
 * The list search box. The URL's `q` owns the committed query; typing commits it after 250ms (never mid-composition,
 * so Korean input is not cut into syllables). `clear` drops a pending commit together with the given params.
 */
export function useSearch() {
  const { route, setParams } = useDashboard();
  const q = route.params.q ?? "";
  const [query, setQuery] = useState(q);
  const timer = useRef<number | null>(null);
  const composing = useRef(false);

  useEffect(() => setQuery(q), [q]);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  const commit = (value: string) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (!composing.current && value !== q) setParams({ q: value }, { replace: true });
    }, 250);
  };
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.value;
    setQuery(value);
    composing.current = event.nativeEvent instanceof InputEvent && event.nativeEvent.isComposing;
    if (!composing.current) commit(value);
  };
  const onCompositionEnd = (event: CompositionEvent<HTMLInputElement>) => {
    composing.current = false;
    commit(event.currentTarget.value);
  };
  const clear = (params: Readonly<Record<string, null>>) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    if ("q" in params) setQuery("");
    setParams(params, { replace: true });
  };
  return { q, query, onChange, onCompositionStart: () => { composing.current = true; }, onCompositionEnd, clear };
}

export function SearchField({ search, label, placeholder }: {
  readonly search: ReturnType<typeof useSearch>; readonly label: string; readonly placeholder: string;
}) {
  return <label className="search">
    <Search size={16} aria-hidden="true" />
    <input data-search aria-label={label} placeholder={placeholder} value={search.query}
      onChange={search.onChange} onCompositionStart={search.onCompositionStart} onCompositionEnd={search.onCompositionEnd} />
    {search.query !== "" && <button type="button" className="search-clear" aria-label={text().clear}
      onClick={event => { search.clear({ q: null }); event.currentTarget.closest("label")?.querySelector("input")?.focus(); }}>
      <X size={14} aria-hidden="true" />
    </button>}
  </label>;
}
