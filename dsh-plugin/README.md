# Novel Studio

A novel writing workbench that lives as a DSH main panel. Click its icon in the
sidebar and the central panel becomes a three-column desk: projects and chapters
on the left, the prose editor in the middle, materials and continuity notes on
the right. Three agent presets — a settings editor, a drafter and an adapter —
work on the same projects, each holding only the tools its role allows.

## Install

```bash
dsh plugin install-bundle D:/AI/novel-studio/dsh-plugin
```

Or from a session: the `plugin_manager` tool with `action: install_bundle` and
that absolute path. The bundle adds one plugin row plus three agent presets; it
becomes neither the default preset nor a replacement for anything.

Projects are plain JSON under `$DSH_HOME/novel-studio` (override with
`DSH_NOVEL_HOME`, or a `root` in the patch row's config). Nothing is written
anywhere else, and the folder stays readable without this plugin.

## The panel

- **Rail** — projects, then the outline of the open one, with word counts and
  statuses. Creating, renaming and deleting a chapter happen here.
- **Editor** — chapter title, prose, and the after-the-fact summary the next
  chapter reads to continue. `Ctrl/Cmd+S` saves. Every save carries the revision
  it expects, so two writers cannot silently overwrite each other. In an
  adaptation project the editor becomes a dual pane: the book's own text on the
  left, the adapted draft on the right, with the adapter's proposal one click
  from the draft and accept/rename/restore beside it.
- **Side** — three tabs: the materials attached to this chapter (attach one,
  create one, detach one), the open continuity notes, and the raw-material
  library. The library is shared by every project: upload a reference novel or a
  notes file, and search it for a name, place or invented term. Hits come back as
  snippets with chapter ids; the settings agent reads whole chapters when it
  needs to.

The panel remembers what was open and restores it on load; that pointer is also
what lets a role agent answer "write this chapter" without being told which one.

## The three presets

`novel-material` (设定官) writes settings, not prose: it can create materials,
attach them to chapters, and set up the outline. `novel-writing` (执笔者) writes
prose from the materials already attached to a chapter, and cannot change the
settings at all. `novel-adapt` (改编者) adapts one chapter of a bound book at a
time, and its only outlet is a proposal the author accepts — it has no tool that
writes prose. The split is enforced by which tools each scope registers, not by
asking a model nicely.

All three run on whatever model the profile is configured with; there is no model
picker of its own.

## Layout

```
lib/index.js        Host half: the store, the routes, the role service, the presets
lib/role-*.js       One preset row per role: which tools it registers, how its prompt renders
lib/role-kit.js     The shared body of a role row
lib/tools.js        Agent tools: the shared read set, the settings set, the writing set
lib/adapt.js        The adapter's prompt, its five tools, and accepting a proposal
lib/proposals.js    Pending adaptation proposals on disk, swept by age and count
lib/tool-kit.js     The ToolDefinition adapter and the parameter helpers
lib/prompts.js      The role system prompts and the context digests
lib/live.js         The cached "what is open" snapshots the prompts read
lib/store.js        Projects on disk: atomic writes, locks, the revision guard
lib/sources.js      Splitting, decoding, tokenising and scoring a reference text
lib/source-store.js The raw-material library on disk
lib/model.js        Pure model layer: word counting, normalisation, file-name encoding
lib/client.js       The browser half: the panel component and its slot registrations
```

Twenty-three tools: eight shared read tools, three that only the settings role
gets, three that only the drafter gets, four source-library tools that only the
settings role gets when a library exists, and five that only the adapter gets.

`docs/DETAIL.md` and `docs/DETAIL.zh.md` explain what was kept from the upstream
project and what the harness replaced.

## Tests

Each layer has one, and they run without the harness:

```bash
node smoke.mjs            # store: atomic writes, locks, 409 on a stale write
node http-test.mjs        # every route through a real HTTP server
node tools-test.mjs       # every tool, against a real store
node source-test.mjs      # splitting, the library on disk, the four source tools
node role-test.mjs        # the snapshot cache and what each role registers
node host-test.mjs        # apply(): the route, the service, the presets, end to end
node client-test.mjs      # the panel component, with a React stand-in
node integration-test.mjs # the real router and the real component, together
node routes-test.mjs      # every path the client calls is a path the host answers
node guard-test.mjs       # the doubles refuse unknown ctx properties like cordis
node live-test.mjs        # against a running harness (needs DSH_WEB_URL)
```

`integration-test.mjs` is the one that catches what the others cannot: it serves
the real router on a real socket and lets the real component talk to it over
real `fetch`, so a payload shape the two sides disagree about shows up as a
failed assertion instead of an empty panel.

`routes-test.mjs` exists because a call the host does not answer is invisible
everywhere else — `client-test.mjs` fakes the reply, and the host tests invent
their own paths. It reads the call sites out of `lib/client.js` and drives each
one through the router.

`live-test.mjs` is the only one that needs the harness running, and it is worth
running before saying a change works: the route prefix, the config argument and
the fiber state are things only the real loader can get wrong.

After editing `lib/index.js`, toggle the plugin once (`plugin_manager`
`set_plugin`) — the loader does not restart a failed or already-active fiber by
itself.

