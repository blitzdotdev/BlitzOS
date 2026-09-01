# Configurable OS-level global shortcuts

Global shortcuts do not use the renderer command registry. Electron main registers
them with `globalShortcut.register`, so they can run while the app is unfocused.

## Cross-process path

- **Shared source of truth:** `@lody/shared/electron-ipc`
  - `GlobalShortcutId` and `GLOBAL_SHORTCUT_DEFAULTS` define ids and default binding
    strings such as `Ctrl+Alt+L` for both processes.
  - IPC contracts are `GlobalShortcutBinding`, `SetGlobalShortcutInput`,
    `SetGlobalShortcutResult`, and `GlobalShortcutSetError`.
  - `bindingToElectronAccelerator` converts a binding to an Electron accelerator and
    rejects invalid or modifier-free bindings. A global bare key would consume that key
    across the OS. Pure conversion tests live in
    `packages/shared/tests/global-shortcut-accelerator.test.ts`.

- **Main process:** `apps/electron/src/main/services/global-shortcuts-service.ts`
  - `GlobalShortcutsService` persists per-user overrides through `Conf`, registers the
    effective bindings, atomically replaces a binding with rollback on conflict, and
    unregisters everything during disposal. `binding: null` is an explicit unbind.
  - `createGlobalShortcutsService` in main injects the behavior handlers; the service
    owns registration/persistence rather than window behavior.
  - `app.getGlobalShortcuts` and `app.setGlobalShortcut` validate IPC input. A trigger
    sends `app.globalShortcut` (`GLOBAL_SHORTCUT_TRIGGERED_CHANNEL`) to an available
    renderer, which owns any analytics event.

- **Renderer:** `lib/native-global-shortcuts.ts` provides a null-safe API wrapper,
  `hooks/use-global-shortcuts.ts` loads and updates bindings, and
  `GlobalShortcutRow` in keyboard settings provides recording, validation, conflict
  feedback, and unbind. `GLOBAL_SHORTCUTS` in `shortcuts.ts` is presentation-only.

## Adding a shortcut

1. Add the id and default binding to `@lody/shared`.
2. Add `{ id, handler }` to `createGlobalShortcutsService`.
3. Add the presentation entry and i18n title to `GLOBAL_SHORTCUTS`.

Persistence, listing, conflict rollback, and settings UI are generic and require no
shortcut-specific changes.
