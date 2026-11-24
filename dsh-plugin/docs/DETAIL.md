# Novel Studio

A novel writing workbench that lives as a DSH main panel. Click its icon in the
sidebar and the central panel becomes a three-column desk: projects and chapters
on the left, the prose editor in the middle, materials and continuity notes on
the right. A new project can be pointed at a folder on your own disk, and then
everything it generates is written there.

## What it keeps

The upstream project (a standalone Tauri + Node app) carried three layers. Only
the domain core is worth keeping, and that is what this bundle is:

- **Projects, chapters, materials, notes** — a project is a folder of plain JSON
  files, so it stays readable, diffable and portable without this plugin.
- **The material model** — thirteen built-in kinds plus author-defined ones, an
  `usage` field telling the assembler when a material is relevant, and explicit
  `chapterIds` attachment.
- **The skeleton/body split** — listing chapters never reads megabytes of prose,
  and a chapter write rewrites only that chapter's file.
- **The revision guard** — every prose write carries the revision it expects.
  A stale write fails instead of silently destroying the other writer's text,
  and the previous body is pushed onto a bounded history.

## What the harness provides instead

| Upstream | Here |
| --- | --- |
| `llm-client.ts` + `llm-relay.ts` (2 600 lines) | the `llm` service |
| 42 providers, 1 500 model entries | `llm.listProviders()` / `listModels()` |
| key storage + Tauri keyring | the `credentials` service |
| settings page and store | the `settings` service and its section slot |
| Node HTTP server + router (4 100 lines) | `webServer.register()` + one route |
| account system (`cloud/*`) | — |
| in-memory session map | `agents` / `sessions` |
| 22 700 lines of SPA shell | React components in a slot |

## Storage

```
$DSH_HOME/novel-studio/            (override with DSH_NOVEL_HOME)
  index.json                       project list for the rail
  projects/<id>/project.json       outline, materials, volumes, notes
  projects/<id>/chapters/<k>.json  one chapter body plus its history
```

A project can instead be written into a folder the author picked, in which case
the same two files sit in that folder and nothing is written under
`projects/<id>`:

```
D:\小说\雨夜\project.json
D:\小说\雨夜\chapters\<k>.json
```

`index.json` gains a `dir` field for those rows and stays the authority on where
a book lives — never the project file itself — so a folder can be moved and
re-pointed without editing the book inside it. Three consequences follow:

- Deleting such a project only unlists it (`keptFiles: true`). The folder is
  the author's; the workbench never deletes files it did not create.
- Picking a folder that already contains a `project.json` is refused with a
  `409`, because writing our skeleton over it would destroy prose we never owned.
- Only absolute paths are accepted; a relative one is a `400`, since it has no
  meaning from the host's working directory.

The folder is chosen through `uiWorkspace.pickDirectory()`, the host's own
dialog. A browser cannot read a real path out of `<input type="file">`, and only
the Host half can create directories, so this is the one place the panel asks the
shell for something.

`<k>` is the chapter id encoded by `encodeFileName()`: only `[A-Za-z0-9_-]`
survives, everything else becomes `_<hex>_`, the result is truncated at 120
characters and a djb2 suffix is appended. This keeps model-generated Chinese
chapter ids inside the Windows 255-byte file-name limit while still mapping two
long ids that share a prefix to different files.

Every write goes to a temporary file and is renamed into place, so a crash
mid-write cannot leave a half-written project.

## Route

The Client half cannot touch the filesystem, so the Host half serves the store
over one same-origin prefix route. Nothing else in the harness reads it.

```
GET    /novel-studio/api/projects
POST   /novel-studio/api/projects
GET    /novel-studio/api/projects/:id
PATCH  /novel-studio/api/projects/:id
DELETE /novel-studio/api/projects/:id
GET    /novel-studio/api/projects/:id/chapters
GET    /novel-studio/api/projects/:id/chapters/:chapterId
PUT    /novel-studio/api/projects/:id/chapters/:chapterId
POST   /novel-studio/api/projects/:id/outline
DELETE /novel-studio/api/projects/:id/outline/:chapterId
POST   /novel-studio/api/projects/:id/materials
DELETE /novel-studio/api/projects/:id/materials/:materialId
POST   /novel-studio/api/projects/:id/notes
GET    /novel-studio/api/active
PUT    /novel-studio/api/active
GET    /novel-studio/api/sources
POST   /novel-studio/api/sources/upload?filename=…&kind=…
GET    /novel-studio/api/sources/:id
DELETE /novel-studio/api/sources/:id
GET    /novel-studio/api/sources/:id/chapters/:chapterId
GET    /novel-studio/api/sources/:id/search?q=…&limit=…
GET    /novel-studio/api/projects/:id/adaptation
PATCH  /novel-studio/api/projects/:id/adaptation
POST   /novel-studio/api/projects/:id/adaptation/cursor
GET    /novel-studio/api/projects/:id/chapters/:chapterId/adapt
POST   /novel-studio/api/projects/:id/chapters/:chapterId/adapt/accept
POST   /novel-studio/api/projects/:id/chapters/:chapterId/adapt/rename
```

A chapter write that carries `expectedRevision` and finds a different stored
revision answers `409` with a message naming both numbers.

`/active` is the pointer to what the author has open. The workbench writes it
whenever the selection changes; the role prompts read it so "this chapter" means
the same thing on both sides of the panel. It is a hint, never a source of
truth — a stale pointer costs one vaguer opening line, and every write is still
guarded by the revision check.

## The raw-material library

A whole reference novel, a world bible or a research dump goes in as one upload
and comes back as searchable chapters:

```
$DSH_HOME/novel-studio/sources/<id>/meta.json
$DSH_HOME/novel-studio/sources/<id>/chapters/<k>.txt
```

Chapter bodies are `.txt`, not JSON, for two reasons: a 4 000-chapter book must
never be read as one blob, and a human should be able to open the folder and read
it. The library scans its own directory instead of keeping an index — sources are
written rarely and read often, so a second source of truth would only cost.

Splitting follows the text, not a setting: two or more `第…章` / `第…节` / `第…回`
/ `Chapter N` headings split by heading, anything else falls back to fixed-size
blocks around 15 000 characters cut on paragraph boundaries. A `document` upload
is always one block — splitting a notes file into "chapters" would invent
structure it does not claim.

`POST /sources/upload` takes the file as the raw request body, not JSON: a
7-million-character novel would cost more than double as an escaped JSON string,
and the browser already holds the bytes. Ceiling is 64 MiB.

Search returns snippets, never whole chapters: it scores every chapter (a heading
hit counts eight times a body hit), quotes up to 8 lines around the best match,
and leaves reading the full chapter to an explicit call.

## The three roles

An agent only sees the tools its **scope** grants it, so the roles are mounted
as preset plugin rows rather than filtered after the fact:

| Preset | Row module | Tools |
| --- | --- | --- |
| `novel-material` | `@local/dsh-novel-studio/role/material` | 8 read tools + `update_outline`, `upsert_material`, `attach_materials` + 4 source-library tools |
| `novel-writing` | `@local/dsh-novel-studio/role/writing` | 8 read tools + `write_chapter`, `append_chapter`, `revise_chapter` |
| `novel-adapt` | `@local/dsh-novel-studio/role/adapt` | 5 read-and-propose tools, no writing tool at all |

The settings agent therefore cannot write prose (it has no writing tool at all)
and the drafter cannot change the setting (it has no material tool). This is the
upstream product's "tool boundary is the responsibility boundary" rule, enforced
by the harness instead of by prompt discipline. The drafter also has no
source-library tool: it works from the materials the settings agent assembled, so
it never has to re-read a reference novel mid-chapter.

The four source tools only appear when a library exists, so a profile with an
empty upload folder does not advertise tools that could only answer "the library
is empty".

Each role registers its system prompt with `complete: true`, so it replaces the
harness persona instead of sitting under it. The prompt is rendered per request
from a cached snapshot of the open project, so the stable part stays
cache-friendly and only the small digest changes.

All three presets are added beside the shipped ones; none becomes the default.

## The three-step entry point

One row of buttons sits under the editor toolbar, and the product's spine is
written on it:

1. **AI materials** — opens a `novel-material` session and asks it to read the
   outline and the materials already there, then fill the gaps.
2. **AI assemble** — the same preset, asked to pick the materials this chapter
   actually needs and attach them.
3. **AI draft** — opens a `novel-writing` session that writes the chapter from
   the materials just attached. On an adaptation project the button becomes
   **AI adapt** and opens `novel-adapt`, because the writer and the adapter
   never share a tool set.

The buttons go through the Client-side `uiWorkspace.startSession()`: they open a
real Session, seed the composer with the book and chapter names, and **do not
send**. A mis-click costs nothing. Once the author sends, the work moves to the
Conversation, because that is where the tool cards, the transcript and the stop
button live — the panel is not a chat window.

Anything unsaved in the editor is saved first: the role prompt is assembled from
the *stored* chapter, so uncommitted prose would be invisible to the agent. With
no edits, that save does not touch the disk.

## The adaptation ledger

An adaptation project is a project bound to a book in the raw-material library.
Its outline is minted from the book's chapters, so `第一章` here means `第一章`
there and a chapter can always be matched to its original text.

The adapter has no writing tool. Its only outlet is `propose_adaptation`, which
writes a proposal to disk and stops:

```
$DSH_HOME/novel-studio/proposals/<project>__<chapter>.json
```

One proposal per chapter, replaced on resubmission, swept after 24 hours. The
author reads it in the dual pane, edits if they like, and presses accept — only
then does the prose land. That is the difference from the drafter: a wrong
adaptation silently overwriting the original would take away the one thing the
author cannot reconstruct, which is what the chapter used to look like.

Accepting enforces, in this order:

- the proposal's `baseRevision` must still be current (`409` otherwise)
- the chapter must be the due one, unless it already has a draft — going back to
  fix an accepted chapter is the point, skipping ahead is not
- the ledger entry is recorded, including a `title` entry when the chapter was
  renamed and an `other` entry when the author typed the text themselves
- the cursor advances only when the due chapter was the one accepted, so
  revisiting chapter one never rewinds later confirmations

`restore` puts a chapter back to the original: empty body, empty summary, status
back to `planned`, cursor back on that chapter, and its non-title ledger entries
dropped.

## Not here yet

The `.novel` package format and the shared material library (materials that live
outside any one project). Both land on top of this store rather than beside it.

