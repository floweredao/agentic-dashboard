import { useState } from "react";
import type { MouseEvent } from "react";
import { ExternalLink, Eye, ThumbsDown, ThumbsUp } from "lucide-react";
import { ARTICLE_REACTIONS } from "../../shared/contracts";
import type { ArticleReaction, DigestArticle, DigestMessage, DigestSummary } from "../../shared/contracts";
import { digestPartItems, partReadAt } from "../model";
import { splitLede, splitUpdate } from "./digest-interaction";
import { type DigestFilter, text, filterParts, SlotMark, slotTitle, clockOf, countsLine, importanceLabel, publishedLabel } from "./digest-common";
/** A summary as its first sentence (what is new, body colour) and the rest (context, muted), without a leading update prefix. */
function Summary({ text: value }: { readonly text: string }) {
  const [lede, rest] = splitLede(splitUpdate(value).text);
  return <span className="digest-card-summary"><span className="digest-lede">{lede}</span>{rest && <> <span className="digest-rest">{rest}</span></>}</span>;
}


/** One digest in the list: unread dot (in all, any unread part with items), its headline (first article title, else the most important message) and counts. */
export function DigestRow({ summary, part, selected, href, onOpen }: {
  readonly summary: DigestSummary; readonly part: DigestFilter; readonly selected: boolean; readonly href: string;
  readonly onOpen: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const t = text();
  const unread = part === "all"
    ? filterParts(part).some(each => digestPartItems(summary, each) > 0 && partReadAt(summary, each) === null)
    : partReadAt(summary, part) === null;
  const first = part === "messages" ? summary.messageHeadline : part === "articles" ? summary.headlines[0] : summary.headlines[0] ?? summary.messageHeadline;
  const headline = first && splitUpdate(first).text;
  return <li><a className={`digest-row${unread ? " unread" : ""}`} href={href} aria-current={selected ? "true" : undefined} onClick={onOpen}>
    <SlotMark slot={summary.slot} />
    <span className="digest-row-main">
      <span className="digest-row-top">
        <span className="digest-row-title">{unread && <span className="unread-dot" aria-hidden="true" />}{unread && <span className="visually-hidden">{t.unread}</span>}{slotTitle(summary.slot)}</span>
        <time className="digest-row-time" dateTime={summary.scheduledAt}>{clockOf(summary.scheduledAt)}</time>
      </span>
      {headline && <span className="digest-row-headline">{headline}</span>}
      <span className="digest-row-meta">
        <span>{countsLine(summary, part)}</span>
        {part !== "articles" && summary.urgent > 0 && <span className="importance urgent">{importanceLabel("urgent")} {summary.urgent}</span>}
        {part !== "articles" && summary.todo > 0 && <span className="importance todo">{importanceLabel("todo")} {summary.todo}</span>}
      </span>
    </span>
  </a></li>;
}


/**
 * One article as a list item: number · source · time and an external-link mark, the title (a leading update prefix becomes a
 * small tag), then the summary unless only titles are shown. The whole item opens the original in a new tab.
 */
const REACTION_ICONS: Record<ArticleReaction, typeof ThumbsUp> = { like: ThumbsUp, dislike: ThumbsDown, seen: Eye };

export type ReactHandler = (section: string, key: string, reaction: ArticleReaction | null) => void;


/**
 * Like · Not for me · Seen it under an article, beside its link (a button never sits inside a link): three toggle buttons
 * (`aria-pressed`) where pressing one replaces the others and pressing the chosen one again takes it back.
 */
function ReactionBar({ title, current, onReact }: { readonly title: string; readonly current: ArticleReaction | undefined; readonly onReact: (reaction: ArticleReaction | null) => void }) {
  const t = text();
  return <div className="digest-react" role="group" aria-label={t.reactTo(title)}>
    {ARTICLE_REACTIONS.map(reaction => {
      const Icon = REACTION_ICONS[reaction];
      const pressed = current === reaction;
      return <button key={reaction} type="button" className="digest-react-btn" aria-pressed={pressed} data-reaction={reaction}
        onClick={() => onReact(pressed ? null : reaction)}><Icon size={14} aria-hidden="true" />{t.reaction[reaction]}</button>;
    })}
  </div>;
}


export function ArticleCard({ item, index, date, section, focused, titles, reaction, onReact }: {
  readonly item: DigestArticle; readonly index: number; readonly date: string; readonly section: string; readonly focused: boolean;
  readonly titles: boolean; readonly reaction?: ArticleReaction | undefined; readonly onReact?: ReactHandler | undefined;
}) {
  const t = text();
  const href = item.originalUrl ?? item.url;
  const meta = [item.source, publishedLabel(item, date)].filter(Boolean).join(" · ");
  const title = splitUpdate(item.title);
  const updated = title.updated || Boolean(item.summary && splitUpdate(item.summary).updated);
  // A picture that fails to load (moved, blocked) leaves the card as it was without one.
  const [broken, setBroken] = useState(false);
  const picture = !titles && !broken && item.imageUrl;
  return <li id={`item-${section}-${item.key}`} className={focused ? "focused" : undefined}>
    <a className={`digest-card${picture ? " with-picture" : ""}`} href={href} target="_blank" rel="noopener noreferrer">
      <span className="digest-card-meta"><span className="digest-num">{String(index + 1).padStart(2, "0")}</span>
        <span className="digest-meta-end">{meta}<ExternalLink className="digest-card-out" size={12} aria-hidden="true" /></span></span>
      <span className="digest-card-title">{updated && <span className="digest-update">{t.updateTag}</span>}{title.text}</span>
      {picture && <img className="digest-thumb" src={picture} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(true)} />}
      {!titles && item.summary && <Summary text={item.summary} />}
    </a>
    {!titles && onReact && <ReactionBar title={title.text} current={reaction} onReact={next => onReact(section, item.key, next)} />}
  </li>;
}


/** One message as a list item: importance, sender, subject, summary (unless only titles are shown) and what to do, which always shows. */
export function MessageCard({ item, section, focused, titles }: { readonly item: DigestMessage; readonly section: string; readonly focused: boolean; readonly titles: boolean }) {
  const t = text();
  const subject = splitUpdate(item.subject);
  // The external mark rides on the last meta piece so a narrow screen never wraps it onto a line of its own.
  const out = item.url && <><ExternalLink className="digest-card-out" size={12} aria-hidden="true" /><span className="visually-hidden">{t.openOriginal}</span></>;
  const body = <>
    <span className="digest-card-meta">
      <span className={`importance ${item.importance}`}>{importanceLabel(item.importance)}</span>
      <span className="message-from">{item.from}{item.address && <span className="message-address"> · {item.address}</span>}{item.merged <= 1 && out}</span>
      {item.merged > 1 && <span className="digest-meta-end">{t.merged(item.merged)}{out}</span>}
    </span>
    <span className="digest-card-title">{subject.updated && <span className="digest-update">{t.updateTag}</span>}{subject.text}</span>
    {!titles && item.summary && <Summary text={item.summary} />}
  </>;
  return <li id={`item-${section}-${item.key}`} className={focused ? "focused" : undefined}>
    {item.url ? <a className="digest-card message-card" href={item.url} target="_blank" rel="noopener noreferrer">{body}</a>
      : <div className="digest-card message-card">{body}</div>}
  </li>;
}
