import { useState } from "react";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { ChevronRight, List, Mail, Maximize2, Newspaper } from "lucide-react";
import { MESSAGE_IMPORTANCE } from "../../shared/contracts";
import type { DigestReactions, Digest } from "../../shared/contracts";
import { FullscreenReader } from "../components/FullscreenReader";
import { BackButton } from "../components/primitives";
import { digestPartItems } from "../model";
import { type DigestFilter, text, inFilter, filterParts, partLabel, sectionTitle, importanceLabel, sortedMessages, SlotMark, slotTitle, clockOf, dayTitle } from "./digest-common";
import { type ReactHandler, MessageCard, ArticleCard } from "./DigestCards";
import { type DigestDensity, useCurrentSection, useTabStrip, jumpTo } from "./digest-interaction";
const NO_SECTIONS: ReadonlySet<string> = new Set();


/**
 * A digest under a filter: date and slot, then its sections in stored order under their own titles, as lists; `listen` and
 * `actions` slot in under the title. A section bar stays stuck above the content: jump chips (the section being read marked
 * `aria-current="location"`) and titles only. Each section head is a disclosure button; `collapsed` sections keep their head
 * and hide the body. The end line counts the items shown.
 */
export function DigestView({ digest, part, focus, actions, listen, collapsed = NO_SECTIONS, onExpand, density = "summary", onDensity, reactions, onReact }: {
  readonly digest: Digest; readonly part: DigestFilter; readonly focus?: string; readonly actions?: ReactNode; readonly listen?: ReactNode;
  /** The owner's reactions by `section:key`; with `onReact` each article shows Like · Not for me · Seen it. */
  readonly reactions?: DigestReactions; readonly onReact?: ReactHandler;
  readonly collapsed?: ReadonlySet<string>; readonly onExpand?: (key: string, expanded: boolean) => void;
  readonly density?: DigestDensity; readonly onDensity?: (density: DigestDensity) => void;
}) {
  const t = text();
  const sections = digest.sections.filter(section => inFilter(part, section.kind));
  const titles = density === "titles";
  const [focused, setFocused] = useState<string | null>(null);
  const fullscreen = focused === digest.id;
  const current = useCurrentSection(sections.map(section => section.key), `${[...collapsed].join()}|${density}|${fullscreen}`);
  const strip = useTabStrip(current, `${sections.map(section => section.key).join()}|${fullscreen}`);
  const shown = sections.reduce((sum, section) => sum + section.items.length, 0);
  const present = filterParts(part).filter(each => digest.sections.some(section => section.kind === each));
  const totals = part === "all" ? present.map(each => t.countedIn(partLabel(each), digestPartItems(digest, each))).join(" · ") || t.count(0)
    : t.countedIn(partLabel(part), digestPartItems(digest, part));
  const updated = digest.updatedAt !== digest.createdAt;
  const content = <>
      {sections.length === 0 && <p className="digest-empty-section digest-part-empty">{t.emptyPart[part]}</p>}
      {sections.length > 0 && <div className="digest-bar">
        {sections.length > 1 && <nav ref={strip} className="digest-jump" aria-label={t.jumpTo}>
          {sections.map(section => <a key={section.key} className="digest-tab" href={`#section-${section.key}`}
            aria-current={current === section.key ? "location" : undefined} onClick={event => {
              event.preventDefault();
              // A collapsed section opens first, so the jump lands on its items.
              if (collapsed.has(section.key)) flushSync(() => onExpand?.(section.key, true));
              jumpTo(section.key);
            }}>{sectionTitle(section)}<span className="digest-tab-count">{section.items.length}</span></a>)}
        </nav>}
        <button type="button" className="icon-btn digest-density" aria-pressed={titles} aria-label={t.titlesOnly} title={t.titlesOnly}
          onClick={() => onDensity?.(titles ? "summary" : "titles")}><List size={18} aria-hidden="true" /></button>
      </div>}
      {sections.map(section => {
        const { key } = section;
        const expanded = !collapsed.has(key);
        const Icon = section.kind === "messages" ? Mail : Newspaper;
        const levels = section.kind === "messages"
          ? MESSAGE_IMPORTANCE.map(level => [level, section.items.filter(item => item.importance === level).length] as const).filter(([, count]) => count > 0) : [];
        return <section key={key} id={`section-${key}`} className="digest-section" aria-labelledby={`section-${key}-title`}>
          <header className="digest-section-head">
            <h3 id={`section-${key}-title`}>
              <button type="button" className="digest-section-toggle" aria-expanded={expanded} aria-controls={`section-${key}-body`}
                onClick={() => onExpand?.(key, !expanded)}>
                <ChevronRight className="digest-chevron" size={16} aria-hidden="true" />
                <span className="digest-section-icon" aria-hidden="true"><Icon size={15} /></span>
                <span className="digest-section-label">{sectionTitle(section)}</span>
                <span className="count">{section.items.length}</span>
              </button>
            </h3>
            {levels.length > 0 && <span className="digest-section-note">{levels.map(([level, count]) => `${importanceLabel(level)} ${count}`).join(" · ")}</span>}
          </header>
          <div id={`section-${key}-body`} className="digest-section-body" hidden={!expanded}>
            {section.shortfall && <p className="digest-shortfall">{section.shortfall}</p>}
            {section.items.length === 0 ? <p className="digest-empty-section">{t.nothingThisTime}</p>
              : <ol className="digest-cards">{section.kind === "messages"
                ? sortedMessages(section.items).map(item => <MessageCard key={item.key} item={item} section={key} focused={focus === `${key}:${item.key}`} titles={titles} />)
                : section.items.map((item, index) => <ArticleCard key={item.key} item={item} index={index} date={digest.date} section={key}
                  focused={focus === `${key}:${item.key}`} titles={titles} reaction={reactions?.[`${key}:${item.key}`]} onReact={onReact} />)}</ol>}
          </div>
        </section>;
      })}
      {sections.length > 0 && <p className="digest-end">{t.end(shown)}</p>}
  </>;
  return <article className={`reader digest${titles ? " titles" : ""}`} aria-labelledby="digest-title">
    <div className="reader-inner">
      <BackButton place="reader" />
      <header className="digest-head">
        <div className="digest-head-text">
          <p className="digest-kicker"><SlotMark slot={digest.slot} />{slotTitle(digest.slot)} · {clockOf(digest.scheduledAt)}</p>
          <h2 id="digest-title" tabIndex={-1} className="reader-title">{dayTitle(digest.date)}</h2>
          <p className="reader-dates">{totals}{updated && <> · {t.updated} {clockOf(digest.updatedAt)}</>}</p>
        </div>
        <div className="digest-head-actions">{actions}
          <button type="button" className="btn btn-outline reader-corner-button reader-fullscreen-button" onClick={() => setFocused(digest.id)}
            aria-label={t.fullscreen} title={t.fullscreenTitle}><Maximize2 size={16} aria-hidden="true" /></button>
        </div>
      </header>
      {listen}
      {fullscreen ? <FullscreenReader title={`${dayTitle(digest.date)} · ${slotTitle(digest.slot)}`} closeLabel={t.exitFullscreen}
        onClose={() => setFocused(null)} wide={false}>{content}</FullscreenReader> : content}
    </div>
  </article>;
}
