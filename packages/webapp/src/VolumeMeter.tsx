/**
 * How full a member's persistent volume is, in one list-row-sized bar.
 *
 * Three states, and they are three different facts rather than three ways of
 * saying one:
 *
 * - no volume at all — "Not attached". Nothing to measure, so no bar.
 * - a volume the guest has measured — the bar, filled, with "62% full".
 * - a volume nobody has measured yet — an empty TRACK, never an empty bar,
 *   with "usage not reported yet". Every box image from before the reporter
 *   shipped is in this state, and drawing 0% for it would be a lie: an
 *   unmeasured disk is not an empty one.
 *
 * The old row said "Attached", which was true and useless — the member could
 * already see they had a disk; what they could not see was whether it was
 * about to run out.
 */

/** Where the bar stops being informational and starts being a warning. A disk
 * this full is the reason anybody looks at this row. */
const FULL_ENOUGH_TO_WARN = 90;

export function VolumeMeter({
  volumeId,
  usedPercent,
}: {
  volumeId: string | null;
  /** 0-100 as the guest last measured it, or null for "not measured yet". */
  usedPercent: number | null;
}) {
  if (volumeId === null) {
    return <span className="volume-meter">Not attached</span>;
  }
  if (usedPercent === null) {
    return (
      <span className="volume-meter">
        <span className="volume-meter-track" />
        <span className="volume-meter-label">usage not reported yet</span>
      </span>
    );
  }
  // A guest can only report 0-100 (the control plane refuses the rest), but the
  // width of a bar is not the place to find that out.
  const percent = Math.min(100, Math.max(0, usedPercent));
  return (
    <span className={percent >= FULL_ENOUGH_TO_WARN ? 'volume-meter volume-meter--warn' : 'volume-meter'}>
      <span
        className="volume-meter-track"
        role="meter"
        aria-label="Persistent volume used"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${String(percent)}% full`}
      >
        <span className="volume-meter-fill" style={{ width: `${String(percent)}%` }} />
      </span>
      <span className="volume-meter-label">{String(percent)}% full</span>
    </span>
  );
}
