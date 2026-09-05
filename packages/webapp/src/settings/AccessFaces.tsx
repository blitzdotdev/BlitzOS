import type { OrgCredentialGrantSubjectKind, OrgCredentialGrantView } from '@blitzos/schema';
import { squareAvatarUrl } from '../avatar-url';
import { accessSubjectLabel, accessSubjectTag, type AccessSubjects } from '../org-credential-access';
import { WorkspaceSigilIcon } from '../shell/WorkspaceStrip';

/* Who can use a credential, as a strip of stacked faces. Styles and the
   layout reasoning are in org-credentials.css under "face strip". */

/** Three faces per class, then the rest become one counter. A fourth face
 * inside a 9px overlap shows about a third of itself — a smear, not a mark. */
const STACK_MAX = 3;

/** Places, then people, then everybody. A fixed order, never the wire's:
 * workspaces start at the same edge on every row, so two credentials compare
 * by looking at one end of the strip. */
const FACE_CLASSES: readonly OrgCredentialGrantSubjectKind[] = ['workspace', 'membership', 'org'];

/** A member face is tinted from its own name so the same person keeps the
 * same colour down the list. Terminal ansi tokens only — the settings surface
 * adds no colours, and these six already carry a light-theme value. */
const FACE_TINTS = [
  '--ansi-blue',
  '--ansi-green',
  '--ansi-magenta',
  '--ansi-cyan',
  '--ansi-yellow',
  '--ansi-red',
] as const;

/** At most two initials: the mark is 24px, and a third letter sets 7px type. */
export function accessFaceInitials(label: string): string {
  const words = label.split(/\s+/u).filter((word) => word !== '');
  return words.slice(0, 2).map((word) => word.slice(0, 1)).join('').toUpperCase();
}

function faceTint(label: string): string {
  let sum = 0;
  // Both `??`s are the compiler's, not a guard: `codePointAt` is typed
  // `number | undefined`, and `noUncheckedIndexedAccess` gives a computed
  // tuple index the same shape. A literal index does not need one, which is
  // why the fallback is `[0]`.
  for (const character of label) sum += character.codePointAt(0) ?? 0;
  return FACE_TINTS[sum % FACE_TINTS.length] ?? FACE_TINTS[0];
}

const CHEVRON_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

/** The member behind a membership row, for the picture on their face. */
function memberFor(
  subject: Pick<OrgCredentialGrantView, 'subjectKind' | 'subjectId'>,
  subjects: AccessSubjects,
): AccessSubjects['members'][number] | null {
  if (subject.subjectKind !== 'membership' || subject.subjectId === null) return null;
  return subjects.members.find(({ id }) => id === subject.subjectId) ?? null;
}

/**
 * One subject as the mark it already wears elsewhere in the product: a
 * workspace's own sigil, a member's own picture, and the accent circle for
 * everyone in the org.
 *
 * NOT A SECOND SET OF MARKS. The rail draws every workspace as
 * `WorkspaceSigilIcon` and the account at its foot as their photo, so a
 * credential's audience is read with the same two glyphs rather than a third
 * alphabet of initials. Initials remain the fallback, and for a member that is
 * exactly `MemberAvatar`'s own rule: a picture when the account has one.
 *
 * `decorative` is what the caller knows and this component cannot: in the
 * strip the face is the only thing naming its subject, and on an access row
 * the name is the next element, where a second announcement is noise.
 */
export function AccessFace({
  subject,
  subjects,
  decorative,
}: {
  subject: Pick<OrgCredentialGrantView, 'subjectKind' | 'subjectId'>;
  subjects: AccessSubjects;
  decorative: boolean;
}) {
  const label = accessSubjectLabel(subject, subjects);
  // The org's own initials, not the sentence's: "everyone in Acme" is the
  // label, and "EI" would be a mark of the preposition.
  const initials = accessFaceInitials(subject.subjectKind === 'org' ? subjects.orgName : label);
  const photo = memberFor(subject, subjects)?.avatarUrl ?? null;
  const workspaceId = subject.subjectKind === 'workspace' ? subject.subjectId : null;
  return (
    <span
      className={`org-access-face org-access-face--${accessSubjectTag(subject.subjectKind)}`}
      // The tint is the fallback's, so an account with a photo does not paint
      // a coloured ring behind it.
      style={subject.subjectKind === 'membership' && photo === null
        ? { background: `var(${faceTint(label)})` }
        : undefined}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative ? true : undefined}
      title={decorative ? undefined : label}
    >
      {workspaceId !== null
        ? <WorkspaceSigilIcon workspaceId={workspaceId} />
        : photo !== null
          ? <img src={squareAvatarUrl(photo)} alt="" />
          : initials}
    </span>
  );
}

/** The stack for one subject class, and the counter for whoever it left out. */
function AccessStack({
  kind,
  grants,
  subjects,
}: {
  kind: OrgCredentialGrantSubjectKind;
  grants: ReadonlyArray<OrgCredentialGrantView>;
  subjects: AccessSubjects;
}) {
  const ofClass = grants.filter((grant) => grant.subjectKind === kind);
  if (ofClass.length === 0) return null;
  // PER CLASS, NOT PER ROW. One `+N` for the whole strip would count members
  // and workspaces together, which is the one thing the split stacks exist to
  // keep apart.
  const rest = ofClass.length - STACK_MAX;
  // "2 more workspaces" / "1 more member": the counter is the only thing on
  // the row naming what it counted, so it names it in the reader's grammar.
  const noun = accessSubjectTag(kind) === 'org' ? 'org-wide' : accessSubjectTag(kind);
  return (
    <span className="org-access-class">
      <span className="org-access-stack">
        {ofClass.slice(0, STACK_MAX).map((grant) => (
          <AccessFace
            key={`${grant.subjectKind}:${grant.subjectId ?? ''}`}
            subject={grant}
            subjects={subjects}
            decorative={false}
          />
        ))}
      </span>
      {rest > 0 && (
        <span
          className="org-access-more"
          role="img"
          aria-label={`${String(rest)} more ${rest === 1 ? noun : `${noun}s`}`}
        >+{rest}</span>
      )}
    </span>
  );
}

/**
 * The whole strip: the stacks, then the chevron that expands the credential
 * row in place.
 *
 * THE ROW ANSWERS "HOW MANY AND WHAT KIND" BEFORE IT ANSWERS "WHO". The chips
 * this replaces spelled every subject out in words, so a key shared with nine
 * workspaces wrapped to three lines and pushed the next credential off the
 * screen. A stack is the same width whatever the audience is, and the names
 * are one chevron away.
 *
 * Empty for a plain reader, whose wire view carries no audience at all: no
 * strip, and no chevron promising rows that do not exist.
 */
export function AccessFaces({
  credentialName,
  grants,
  subjects,
  expanded,
  onToggle,
}: {
  credentialName: string;
  grants: ReadonlyArray<OrgCredentialGrantView>;
  subjects: AccessSubjects;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (grants.length === 0) return null;
  return (
    <div className="org-access-strip">
      {FACE_CLASSES.map((kind) => (
        <AccessStack key={kind} kind={kind} grants={grants} subjects={subjects} />
      ))}
      <button
        className="org-access-chevron"
        type="button"
        aria-expanded={expanded}
        aria-label={expanded
          ? `Hide who has access to ${credentialName}`
          : `Show who has access to ${credentialName}`}
        onClick={onToggle}
      >{CHEVRON_ICON}</button>
    </div>
  );
}
