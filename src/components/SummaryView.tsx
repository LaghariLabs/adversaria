import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  FileText,
  Heart,
  LineChart,
  ListChecks,
  MessageCircle,
  RefreshCw,
  Sprout,
  type LucideIcon,
} from "lucide-react";
import {
  isPlaceholderBullet,
  isRtl,
  parseSummary,
  splitLabel,
  type SummarySection,
} from "../lib/summary";
import type { ActionItem } from "../types";

interface SummaryViewProps {
  summary: string;
  /** Action items from the DB (ordered by ord), used as the authority for done-state. */
  actionItems: ActionItem[];
  /** Called when an actionable bullet's checkbox is toggled. */
  onToggleActionItem: (id: number, done: boolean) => void;
}

/** Icon + accent colour for a section, chosen by keywords in its heading. */
function sectionMeta(heading: string): { Icon: LucideIcon; accent: string } {
  const h = heading.toLowerCase();
  if (/key topic|discussion point|المواضيع|النقاط|المناقشة|مواضيع/.test(h)) return { Icon: ClipboardList, accent: "text-blue-600" };
  if (/decision|agreement|القرارات|قرارات|الاتفاق|الاتفاقيات/.test(h)) return { Icon: CheckCircle2, accent: "text-emerald-600" };
  if (/action item|next step|deliverable|الإجراءات|المهام|الخطوات|خطوات|بنود العمل/.test(h)) return { Icon: ListChecks, accent: "text-amber-600" };
  if (/follow.?up|المتابعة|متابعة/.test(h)) return { Icon: RefreshCw, accent: "text-violet-600" };
  if (/risk|concern|blocker|المخاطر|مخاطر|العوائق|المشاكل/.test(h)) return { Icon: AlertTriangle, accent: "text-rose-600" };
  if (/status|progress|الحالة|التقدم|الوضع/.test(h)) return { Icon: LineChart, accent: "text-sky-600" };
  if (/feedback|الملاحظات|التعليقات|ملاحظات/.test(h)) return { Icon: MessageCircle, accent: "text-cyan-600" };
  if (/personal|well.?being|الشخصية|الرفاهية/.test(h)) return { Icon: Heart, accent: "text-teal-600" };
  if (/career|growth|المهنية|النمو|التطور/.test(h)) return { Icon: Sprout, accent: "text-green-600" };
  if (/topics for next|مواضيع المرة القادمة|للمرة القادمة|للمرة القادمة/.test(h)) return { Icon: CalendarDays, accent: "text-indigo-600" };
  return { Icon: FileText, accent: "text-gray-300" };
}

export function SummaryView({ summary, actionItems, onToggleActionItem }: SummaryViewProps) {
  const { preamble, sections } = useMemo(() => parseSummary(summary), [summary]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Nothing parseable — fall back to the raw text so we never show blank.
  if (sections.length === 0 && preamble.length === 0) {
    return (
      <div className="summary-markdown">
        <p style={{ whiteSpace: "pre-wrap" }}>{summary}</p>
      </div>
    );
  }

  const toggleCollapse = (heading: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(heading) ? next.delete(heading) : next.add(heading);
      return next;
    });

  // Counter for actionable bullets across all sections — maps to actionItems[ord].
  let actionableIdx = 0;

  return (
    <div className="summary-markdown">
      {preamble.length > 0 && (
        <p dir="auto">{preamble.join(" ")}</p>
      )}

      {sections.map((section) => {
        const meta = sectionMeta(section.heading);
        const isCollapsed = collapsed.has(section.heading);
        // Direction is decided by the heading only — an English section must not
        // flip to RTL just because one bullet embeds an Arabic term (e.g.
        // "…retained plates (تمليك) Ownership transfer"). Each bullet carries
        // dir="auto" below so mixed-script lines resolve per-line.
        const rtl = isRtl(section.heading);
        return (
          <div key={section.heading} className="summary-section" dir={rtl ? "rtl" : "ltr"}>
            <h3>
              <button
                type="button"
                onClick={() => toggleCollapse(section.heading)}
                aria-expanded={!isCollapsed}
                title={isCollapsed ? "Expand section" : "Collapse section"}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  background: "none",
                  border: "none",
                  padding: 0,
                  margin: 0,
                  cursor: "pointer",
                  color: "inherit",
                  font: "inherit",
                  width: "100%",
                  textAlign: rtl ? "right" : "left",
                }}
              >
                <meta.Icon size={17} aria-hidden="true" />
                <span style={{ flex: 1 }}>{section.heading}</span>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>
                  {section.bullets.length}
                </span>
                <span
                  aria-hidden="true"
                  style={{
                    display: "inline-block",
                    transform: isCollapsed ? "none" : "rotate(90deg)",
                  }}
                >
                  ›
                </span>
              </button>
            </h3>

            {!isCollapsed && (
              <ul>
                {section.bullets.length === 0 ? (
                  <li>{rtl ? "لا يوجد" : "None mentioned"}</li>
                ) : (
                  section.bullets.map((bullet, i) => {
                    // Map the Nth actionable bullet to actionItems[N] (by ord).
                    // Placeholders ("None mentioned") must NOT consume an index:
                    // the Rust extractor skips them, so counting them here bound
                    // every following checkbox to the wrong action item.
                    const real = section.actionable && !isPlaceholderBullet(bullet);
                    const item = real ? actionItems[actionableIdx++] : undefined;
                    return (
                      <BulletItem
                        key={i}
                        text={bullet}
                        actionable={real}
                        item={item}
                        onToggle={() => {
                          if (item) onToggleActionItem(item.id, !item.done);
                        }}
                      />
                    );
                  })
                )}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface BulletItemProps {
  text: string;
  actionable: boolean;
  item?: ActionItem;
  onToggle: () => void;
}

function BulletItem({ text, actionable, item, onToggle }: BulletItemProps) {
  const { label, rest } = splitLabel(text);
  const checked = item?.done ?? false;
  const body = (
    <span>
      {label && <b>{label}: </b>}
      {rest}
      {/* The deadline is stripped out of the bullet text by parseSummary so the
          sentence reads cleanly — but it was then rendered NOWHERE, so a spoken
          deadline vanished from the note entirely (2026-08-03 review). Show it
          from the stored column, which is authoritative: the user can edit it
          in the To-dos tab, and that edit should win here too. */}
      {item?.due && <span className="badge-due">{item.due}</span>}
    </span>
  );

  if (actionable && item) {
    return (
      <li className={`task-item${checked ? " checked" : ""}`} dir="auto">
        <input type="checkbox" checked={checked} onChange={onToggle} />
        {body}
      </li>
    );
  }

  // Actionable bullet without a matching DB item — render without checkbox.
  if (actionable && !item) {
    return <li dir="auto">{body}</li>;
  }

  return <li dir="auto">{body}</li>;
}

export type { SummarySection };
