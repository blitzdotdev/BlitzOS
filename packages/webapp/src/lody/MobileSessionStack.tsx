/**
 * Lody's phone experience, mounted for real.
 *
 * WHAT THIS IS. Upstream owns two mobile layouts — `ChatLanding` renders
 * `MobileHomeScreen`/`MobileProjectScreen` below 768px, and `SessionDetail`
 * renders its own floating-header layout with a tab sheet and a menu sheet.
 * Neither one is reachable as upstream intends it unless a STACK holds them:
 * `vendor/lody/packages/components/src/components/mobile/mobile-workspace-stack.tsx`
 * keeps the landing mounted as a base and layers the session over it in a Vaul
 * right-drawer, so back reveals the landing live and an edge swipe pops it.
 *
 * WHY IT IS REPRODUCED HERE AND NOT MOUNTED. Their stack is mounted by
 * `MobileWorkspaceLayout`, inside `MainLayout` — the tree that also builds
 * `LoroAppSidebar`, `MobileSidebarDrawer`, `TerminalDockHost`, the bug-report
 * dialog and the desktop settings modal. BlitzOS mounts none of those (the
 * scope record calls that area 3, and `plans/LODY-V1-SCOPE.md` §1 keeps it
 * KILL), and their stack accepts one prop — `workspaceName`. It has no way to
 * take the seven BlitzOS props the two pages need: seam patch 4's `readOnly`,
 * seam patch 5's host tabs, seam patch 6's Side Chat rule, and seam patch 7's
 * four v1 suppressions. Widening it would be a large vendor patch that upstream
 * could not take, so the repo rule applies (`CLAUDE.md`: integration code lives
 * in `packages/webapp/src/lody/`) and this file composes their components the
 * way `TerminalTabsStrip.tsx` composes `SessionTabBar`.
 *
 * WHAT IS COPIED VERBATIM, AND WHY EACH ONE MATTERS. Their four decisions are
 * reproduced with their reasons, because each one is a bug if it is dropped:
 *
 * 1. **The base stays mounted.** `ChatLanding` is never torn down when a
 *    session opens, so its scroll position and its unsent draft survive, and it
 *    is genuinely visible under the drawer during the slide.
 * 2. **The last session is sticky.** The route — and so `sessionId` — is gone
 *    the instant back is pressed, but Vaul keeps the content mounted for the
 *    close animation. Without the ref the panel animates out blank.
 * 3. **Close NAVIGATES, it does not pop history.** A PR or browser drawer can
 *    push then replace a same-session entry; popping one keeps `sessionId`
 *    present, so Vaul has written a half-open transform that controlled `open`
 *    never clears.
 * 4. **`repositionInputs` follows the shell.** On mobile web the keyboard
 *    shrinks the layout viewport and Vaul captures the shrunk height as the
 *    initial one, so the composer stays lifted after the keyboard closes.
 *    BlitzOS is always mobile WEB, so `isNativeAppShell()` is always false
 *    here; the call is kept rather than folded to `false` so a merge that
 *    changes their rule reaches us.
 *
 * WHAT IS DELIBERATELY NOT COPIED. Their `AppThemeShell` wrapper around the
 * session is kept (the page paints `bg-background`), and their `useTranslation`
 * drawer title is kept. Their `mobileWorkspaceBaseContextAtom` write stays in
 * `router.tsx`'s `ChatRoute`, exactly where their own chat route does it.
 */
import { useCallback, useRef } from "react";
import { useAtomValue } from "jotai";
import { useParams, useRouter, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ChatLanding } from "@lody/components/components/chat/chat-landing";
import SessionDetail from "@lody/components/components/sessions/session-detail";
import { AppThemeShell } from "@lody/components/components/app-theme-shell";
import { Drawer, DrawerContent, DrawerTitle } from "@lody/components/ui/drawer";
import { VaulDrawerBody } from "@lody/components/components/mobile/vaul-drawer-edge-back-zone";
import { mobileWorkspaceBaseContextAtom } from "@lody/components/atoms";
import { isNativeAppShell } from "@lody/components/lib/native-platform";
import {
  getMobileMainLayoutContentClassName,
  getMobileMainLayoutRootClassName,
} from "@lody/components/components/workspace-layout-utils";
import { LODY_CHAT_ROUTE, LODY_SESSION_ROUTE } from "./route-ids.js";
import { TerminalTabsHost } from "./TerminalTabsStrip.js";
import { useSurfaceTabs } from "./surface-tabs.js";
import { lodyV1SuppressionProps } from "./v1-scope.js";

/** Seam patches 7 and 15's props, built once — the same constant `router.tsx`
 * builds, for the same reason: the scope is a build-time decision. */
const V1 = lodyV1SuppressionProps();

/**
 * The drag zone's top offset, their constant and their arithmetic: the header
 * (`3.5rem` + the safe area) plus the tab strip (`2.25rem`). It must clear the
 * chrome above the conversation, or the back button and the tab strip stop
 * being tappable because the edge zone covers them.
 */
const SESSION_DRAWER_BODY_TOP_INSET = "calc(3.5rem + 2.25rem + var(--safe-area-top, 0px))";

/** The shape their `mobileWorkspaceBaseContextAtom` holds, and the shape the
 * chat route's search carries. Stated here because the vendor seam is `any`. */
export interface MobileBaseContext {
  context?: string;
  machine?: string;
  project?: string;
  repo?: string;
  /**
   * OURS, and upstream's stack drops it.
   *
   * The BlitzOS rail's "New session" clears the landing's draft by writing a
   * fresh key into the address (`use-lody-rail.ts`). Upstream has no such
   * control, so their stack's search type omits the field and a phone would
   * take a rail press and do nothing visible. It is read only while the
   * address IS the landing, which is the only time the landing is on screen.
   */
  resetDraftKey?: string;
}

/** Their `getMobileBaseChatSearch`: the search that re-opens the base page the
 * session was opened from. A context we do not recognise resolves to the plain
 * landing rather than to a half-built address. */
export function mobileBaseChatSearch(base: MobileBaseContext): MobileBaseContext {
  if (base.context === "local") {
    return base.machine !== undefined && base.project !== undefined
      ? { context: "local", machine: base.machine, project: base.project }
      : { context: "local" };
  }
  if (base.context === "github") {
    return base.repo !== undefined ? { context: "github", repo: base.repo } : { context: "github" };
  }
  if (base.context === "chat") return { context: "chat" };
  return {};
}

export interface MobileSessionStackProps {
  workspaceName: string;
  /** Seam patch 4, fixed per router. See `LodySessionRouterOptions.readOnly`. */
  readOnly: boolean;
}

export function MobileSessionStack({ workspaceName, readOnly }: MobileSessionStackProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const rememberedBase = useAtomValue(mobileWorkspaceBaseContextAtom);
  const surfaceTabs = useSurfaceTabs();

  // Live while the address IS the landing; absent on a session route, where the
  // remembered context is what keeps the right page under the drawer.
  const liveChatSearch = useSearch({ from: LODY_CHAT_ROUTE, shouldThrow: false });
  const base: MobileBaseContext = liveChatSearch ?? rememberedBase;

  const sessionParams = useParams({ from: LODY_SESSION_ROUTE, shouldThrow: false });
  const sessionSearch = useSearch({ from: LODY_SESSION_ROUTE, shouldThrow: false });
  const sessionId: string | undefined = sessionParams?.sessionId;
  const open = sessionId !== undefined;

  // Their sticky ref. See the header comment, point 2.
  const lastSessionRef = useRef<{
    id: string;
    tab?: string;
    pr?: number;
    browser?: boolean;
  } | null>(null);
  if (sessionId !== undefined) {
    lastSessionRef.current = {
      id: sessionId,
      tab: sessionSearch?.tab,
      pr: sessionSearch?.pr,
      browser: sessionSearch?.browser,
    };
  }
  const rendered = lastSessionRef.current;

  const handleClose = useCallback(() => {
    void router.navigate({
      to: "/$workspaceName/chat",
      params: { workspaceName },
      search: mobileBaseChatSearch(base),
      replace: true,
    });
  }, [base, router, workspaceName]);

  // The six props of seam patch 5. Seam patch 16 adds no prop of its own for
  // the mobile tab sheet — it makes these same six reach it.
  // `onSessionMissing` is the landing's own recovery and is raised by the
  // session host alone.
  const hostTabs = surfaceTabs === null
    ? {}
    : {
        surfaceTabs: surfaceTabs.tabs,
        activeSurfaceTabId: surfaceTabs.activeTabId,
        onSurfaceTabSelect: surfaceTabs.onSelect,
        onSurfaceTabClose: surfaceTabs.onClose,
        onSessionTabSelect: surfaceTabs.onDeselect,
        onSessionMissing: surfaceTabs.onSessionMissing,
      };

  const landing = (
    <ChatLanding
      workspaceSlug={workspaceName}
      preSelectedContext={base.context}
      preSelectedMachine={base.machine}
      preSelectedProject={base.project}
      preSelectedRepo={base.repo}
      resetDraftKey={base.resetDraftKey}
      // Seam patch 7's two landing props, seam patch 15's connectivity one,
      // and seam patch 16's settings one.
      //
      // `hideProductHints` reached only the DESKTOP hint band before seam patch
      // 16: the mobile home screen returns above that line and draws its own
      // "Lody runs on your computer / Download Lody" takeover instead. Seam
      // patch 16 makes the same flag answer both.
      hideProductHints={V1.hideProductHints}
      hideAgentRoles={V1.hideAgentRoles}
      // The settings gear in the mobile home header has no desktop counterpart
      // and so had no gate until seam patch 16. The connection pill beside it
      // is seam patch 15's, on its own call site.
      hideSettingsEntry={V1.hideSettingsEntry}
      hideConnectionStatus={V1.hideConnectionStatus}
    />
  );

  // The landing keeps the host tabs' CONTENT and loses their STRIP on a phone;
  // see `TerminalTabsHost`'s `showStrip`.
  const landingHost = surfaceTabs === null
    ? landing
    : <TerminalTabsHost surfaceTabs={surfaceTabs} landing={landing} showStrip={false} />;

  /* Upstream's own containers, reproduced. Their layout wraps the stack in
     `getMobileMainLayoutRootClassName()` (a full-height flex row that carries
     the native-keyboard offset), then a content column, then
     `relative min-h-0 flex-1 overflow-hidden`. The mobile pages size
     themselves against that chain — a `h-full` page inside an auto-height
     parent collapses — and BlitzOS does not mount the layout that supplies it,
     so this mount supplies it instead. */
  return (
    <div className={getMobileMainLayoutRootClassName()}>
      <div className={getMobileMainLayoutContentClassName()}>
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {landingHost}
          <Drawer
            direction="right"
            repositionInputs={isNativeAppShell()}
            open={open}
            onOpenChange={(next: boolean) => {
              if (!next) handleClose();
            }}
          >
            <DrawerContent
              className="safe-areas w-full! max-w-none! inset-0 border-0 border-l-0! rounded-none"
              data-sidebar-swipe-open-disabled
            >
              <DrawerTitle className="sr-only">
                {t("sessions.prTab.conversation", "Conversation")}
              </DrawerTitle>
              <VaulDrawerBody topInset={SESSION_DRAWER_BODY_TOP_INSET}>
                {rendered && (
                  <AppThemeShell>
                    <SessionDetail
                      sessionId={rendered.id}
                      urlTab={rendered.tab}
                      // Their rule: while the session drawer closes we still mount
                      // the page so it can slide out, but a nested PR or browser
                      // drawer must not stay on top of the landing for those frames.
                      urlPrNumber={open ? rendered.pr : undefined}
                      urlBrowser={open ? rendered.browser : false}
                      onMobileBack={handleClose}
                      readOnly={readOnly}
                      sideChatRequiresAssistantTurn
                      hideCloudMenuItems={V1.hideCloudMenuItems}
                      hideNotificationPrompt={V1.hideNotificationPrompt}
                      hideAgentRoles={V1.hideAgentRoles}
                      keyboardShortcutsAvailable={V1.keyboardShortcutsAvailable}
                      hideLanguageServiceActions={V1.hideLanguageServiceActions}
                      // Seam patch 16. The props above are the SAME props the
                      // desktop mount passes, and before that patch four of them
                      // reached nothing on a phone: the mobile branch returns 952
                      // lines above `getSharedChatSurfaceProps`, so it hand-wrote a
                      // `SessionChatInterface` that took `readOnly` and no `hide*`.
                      // The mobile "…" sheet builds its own action list too, so Copy
                      // URL, Share with team and Change owner each need the term the
                      // desktop menu already has.
                      //
                      // `hideConnectionStatus` is seam patch 15's prop, declared
                      // and mostly wired by it. Its hunk 13 forwards it through
                      // that shared builder, so the composer status chip is the
                      // one connection surface the mobile fork still dropped.
                      hideConnectionStatus={V1.hideConnectionStatus}
                      {...hostTabs}
                    />
                  </AppThemeShell>
                )}
              </VaulDrawerBody>
            </DrawerContent>
          </Drawer>
        </div>
      </div>
    </div>
  );
}
