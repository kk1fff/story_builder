# Story Builder

Story Builder is a web canvas for working out an answer to a question. People can build a story by hand or invite an agent to help develop the reasoning, edit the canvas, and write an answer.

## Run locally

Use Node 26 and npm.

```sh
npm ci
npm run build
npm start
```

Open [the workspace](http://127.0.0.1:4310) to create an empty project. The app stores data in `data/story.sqlite` by default. Set `STORY_DB` to use a different file. The [MCP setup guide](http://127.0.0.1:4310/mcp) describes the tools and how to give an agent a project or review ID.

For a container deployment, run `docker compose up --build`. Compose binds to loopback and uses a named data volume. To host on a trusted internal interface, set `STORY_BIND_ADDRESS` to that interface's IP and `STORY_ALLOWED_ORIGINS` to a comma-separated list of exact web origins, such as `http://story-builder.internal:4310`. The same configured URL serves the web UI and MCP. Keep the data volume when restarting. Check `GET /healthz` to verify the service can access its store.

## Run checks locally

```sh
npx playwright install --only-shell chromium
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Browser checks run in headless Chromium. See [acceptance walkthrough](docs/acceptance.md) for the GCC case and the external agent test.

## Prototype scope

A new project opens on an empty canvas. The user can add any kind of box and use the editor independently. They can connect an agent later and give it the project ID.

### Boxes and connections

| Box | What it captures |
| --- | --- |
| Problem | A gap or difficulty. |
| Event | Something that happened. |
| Proposal | An approach under consideration. |
| Reasoning | A premise, inference, or explanation. |
| Question | Something the story needs to answer. |
| Action | An outcome someone intends to bring about. |
| Decision | A choice someone made. |
| Context | The existing environment, such as available technology, rules, or resources. |

Every box can open to show text, a nested canvas, or both. Each block has one location and a stable ID. Moving a block changes its path and keeps its links and annotations attached.

Select a box to find its resize grip and connection controls. Drag the lower-right corner to resize, or enter dimensions in the box panel. Draw a connection from the right-edge handle to a visible destination, then choose the relationship. Use **Connect** on the box to pick a destination inside a closed box or to connect by keyboard or touch.

Connectors have a direction and a label, such as **motivates**, **supports**, **causes**, **solves**, or **answers**. Reverse wording like **caused by** describes the same connector. Links can reach blocks at any depth. They appear solid when both endpoints are visible and dashed when an endpoint is represented by a closed ancestor. Inspecting a dashed link shows the actual endpoints and lets the user jump to them. The connection picker keeps the source selected while the user browses from the main canvas to the destination.

A Question can designate one box as its **Derived result** in each version. The marked box holds the written answer. The human or agent can write in it. The human can request a targeted revision or regeneration through an annotation.

### Human and agent editing

- The web UI controls agent access to edits. It can lock editing, unlock selected boxes, allow adding boxes, or allow full editing. Adding connections requires permission to change the affected endpoints.
- The user can share a selection to give the agent a starting point. In **Review**, the user can annotate one or more boxes and send a batch of notes with their targets and working revision. Applied notes point to their changes, and notes that need input or an unlock stay open.
- The agent traces important conclusions back to the events, premises, and constraints that support them. When depth or scope needs clarification, it shows a representative breakdown and asks a focused question. It uses nested boxes for detail the reader can inspect.
- The agent submits agreed edits as one batch. The story backend checks the current edit restrictions and the live revision, including edits waiting to appear in History. Independent edits can land together. Overlapping edits are surfaced for review or can be explored on a separate branch.

### History

The first unsaved edit starts a version window on its branch. Save a snapshot at the first of these events.

1. The human chooses **Save**.
2. Five seconds pass without another edit.
3. Thirty seconds pass since the first unsaved edit.

Human edits and atomic agent batches use the same window. A version records its contributors and can include both. The History panel shows the version graph and supports naming versions, viewing them, and comparing any two versions. Continuing from an earlier version creates a new branch and preserves the existing history.

### Agent connection

The prototype targets internal hosting, with authentication deferred. It uses one stable `/mcp` URL. A browser GET serves the setup guide and tool catalog. MCP requests use the same URL over Streamable HTTP. The agent calls `start_session(project_id)` after receiving the project ID, and every subsequent Story Builder tool takes the returned `session_id`. Sessions identify the project and branch. The web UI and agent tools share the story backend.

## First walkthrough

1. Create an empty project and build a small story by hand.
2. Connect an agent and direct it to the project.
3. Annotate a nested box and send the review. Inspect the agent's sample before settling the level of detail.
4. Apply the edits, name the version, and compare it with the earlier canvas.
5. Draft the marked answer and follow a sentence back to a supporting block inside a closed box.
