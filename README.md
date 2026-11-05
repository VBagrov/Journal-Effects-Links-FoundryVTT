# Journal Effects Links

A Foundry Virtual Tabletop V13 module for distributing temporary Items and Active
Effects to player characters from reusable **Effect Sets**, opening the live set
manager from journal links, and revoking distributed documents safely.

Designed for D&D 5e (`dnd5e`) but not tied to a specific system version: item
types are read from the installed system at runtime, and the module has no
mandatory third-party dependencies.

## Installation

1. Copy this folder into `Data/modules/journal-effects-links` (or install it as
   a module package).
2. Enable **Journal Effects Links** in the world's module settings.
3. As a GM, open the **Journal** sidebar. A wand button labelled **Effect Sets**
   appears in the Journal directory header. The manager can also be opened from
   the wand tool in the Scene Controls (token controls) or from the link dialog.

## Usage

### Create a set

1. Click **Effect Sets** → **New Effect Set**.
2. Name it and optionally add a description and icon.
3. Drag Items or Active Effects into the object panel, or use
   **From world items**. The browser can list the world or any Item/Active Effect
   compendium, so objects can be taken from compendiums without dragging.
   Dropping a document onto an existing row replaces that row. An Active Effect
   that belongs to an Item is imported as the whole Item.
4. Select recipients. Playable characters are selected by default; NPCs are
   hidden until **Show NPCs** is enabled. An Actor can also be dropped into the
   editor to add it as a recipient immediately.
5. Click **Save** (or **Save draft** for an empty set).

### Editing an active set

Saving an active set applies removals only: documents of recipients or objects
that were removed from the set are revoked immediately, because they no longer
belong to it. New objects and recipients are **not** granted by saving — they
are created by an explicit synchronization, so accidental additions never
distribute anything.

### Distribute

- **Activate** opens the synchronization preview; documents are created only
  after you confirm. Activation is idempotent: if an active grant already
  exists it does nothing. Use synchronization to apply later changes.
- **Synchronize** opens a preview of the differential plan. Only documents that
  are missing on a recipient are created; verified copies are left alone.
  Choose a mode:
  - **Add Missing Only** — create missing documents, never remove or overwrite.
  - **Apply Configuration** (default) — add/remove objects and recipients, but
    preserve player modifications to existing copies.
  - **Full Template Synchronization** — additionally overwrite verified managed
    copies with template data.
  Manually deleted documents on a recipient are detected as missing and are
  re-created by the next synchronization; the management window lists how many
  objects each recipient is missing.
- By default the module does not create duplicate copies: if the recipient
  already has an item or effect with the same name and type, it is skipped and
  listed in the preview. Enable **Create duplicate copies** in the module
  settings to grant copies anyway. Pre-existing documents are never adopted,
  modified, or deleted.
- **Revoke** removes only documents positively verified as created by this module.
  Documents that were already deleted manually are treated as already revoked,
  so revoking a set does not report errors for them. The grant table also has a
  per-recipient button that revokes every set from that Actor at once.
- **Copy journal link** produces `@EffectLink[set_...]{Set Name}` for use in any
  journal page. Links reference the immutable set ID, so renaming is safe.
- In the journal page editor toolbar, the wand button opens a set picker and
  inserts the link at the current cursor position. The same dialog has an
  **Open Manager** button, and the manager is also available from the Scene
  Controls wand tool.

### Manage

The global manager has tabs for sets, active grants, issues, and operation
history. It supports search, status filtering and sorting, per-object and
per-recipient revocation, duplication, journal lookup, registry repair, and a
global **Revoke All Active Grants** action.

## Safety model

The module keeps a persistent grant registry in a hidden, GM-owned JournalEntry
(one page per set plus one registry page). Every created document receives flags:

```json
{
  "flags": {
    "journal-effects-links": {
      "managed": true,
      "setId": "set_…",
      "grantId": "grant_…",
      "templateObjectId": "obj_…",
      "instanceId": "instance_…"
    }
  }
}
```

Tracked documents are deleted only when the registry record, Actor UUID,
document UUID, and every flag match. Documents left behind by an interrupted or
corrupted operation are also cleaned up during revocation, but only when they
carry the complete managed flag set and reference a grant and template that
belong to the set. Documents are never identified by name, type, image, or
similarity. If a document was edited, moved, or replaced in a way that breaks
verification, it is reported as a conflict and left untouched. Unrelated Actor
documents are never deleted, and Actors are never rebuilt or reset.

If the registry is corrupted, destructive operations are disabled. The manager
can rebuild records from verifiable document flags, with a GM-reviewed preview.

## Permissions

Only GMs can open the manager or perform any mutation. Players who click an
EffectLink receive a permission notification. Set data and the registry live in
a journal with no player ownership, so they are not exposed to players.

## Storage and schema

- Storage: module-owned hidden `JournalEntry`; set definitions and the grant
  registry are stored in journal page flags, not HTML or `localStorage`.
- `schemaVersion: 1`; stored sets, grants, recipients and instances are migrated
  on read.
- Per-set operation locks live in the registry with a timeout, preventing two
  GM clients from mutating the same grant simultaneously.
- History is capped at 300 entries.

## Module API

After `ready`, GMs can use:

```js
game.modules.get("journal-effects-links").api;
// { openGlobalManager, openSetManagement, setManager, grantManager, revocationManager }
```

Internal hook fired after changes: `journalEffectsLinks.setChanged`.

## Development

- Entry point: `scripts/main.js`
- Core engines: `scripts/core/`
- ApplicationV2 UIs: `scripts/applications/`
- Integrations: `scripts/integrations/`
- Templates: `templates/`
- Localization: `lang/en.json`, `lang/ru.json`
