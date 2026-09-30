'use client';

/**
 * One group of settings, folded until it is wanted.
 *
 * A form of thirty fields is read from the top every time, even to change one of them. Panel
 * editors solve this by category -- Grafana folds its options the same way -- and two rules
 * keep it honest: a group this thing cannot use is not drawn at all, and a group already
 * carrying a setting opens by itself, so nothing configured hides behind a closed lid.
 */
export function Section({
  title,
  note,
  open = false,
  when = true,
  children,
}: {
  title: string;
  note?: string;
  open?: boolean;
  /** False when there is nothing in the group: the group is not drawn. */
  when?: boolean;
  children: React.ReactNode;
}) {
  if (!when) return null;
  return (
    <details className="form-section" open={open}>
      <summary>
        <span className="form-section-name">{title}</span>
        {note && <small>{note}</small>}
        <i className="form-section-chevron" aria-hidden="true" />
      </summary>
      <div className="form-section-body">{children}</div>
    </details>
  );
}
