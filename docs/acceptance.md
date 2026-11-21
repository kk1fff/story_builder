# GCC prototype acceptance

Use a disposable local database and a headless Playwright Chromium browser. The walkthrough exercises the same project through the web UI and a separate Codex CLI process connected to the local MCP endpoint.

## Start the checks

From the repository root, install dependencies and run the project checks.

```sh
npm ci
npx playwright install chromium
npm run typecheck
npm test
npm run build
npm run test:e2e
```

For the live agent walkthrough, start the built server in a separate terminal.

```sh
acceptance_dir=$(mktemp -d "${TMPDIR:-/tmp}/story-builder-acceptance.XXXXXX")
STORY_DB="$acceptance_dir/gcc.sqlite" STORY_HTTP_PORT=4310 npm start
```

Use `http://127.0.0.1:4310` for the browser. Verify that an ordinary request to `/mcp` shows the server URL, setup guidance, and available tools.

## Build and annotate the story

- [ ] Create a project named **GCC walkthrough** and verify that it opens on an empty canvas. Complete this section before connecting the agent.
- [ ] Add the root question **Why did GNU need its own compiler?**, the Decision **Write a new compiler**, and the Reasoning box **GNU needed a compiler that fit the target machine**. Open the decision and add **Adapt Pastel** and the finding **Pastel exceeds the target's stack limit**. Open that finding and add the nested Event **Tried the 68000 port**. Leave the finding's text detail for the agent review to fill in.
- [ ] Connect the nested finding to the root Reasoning box with **supports**. Use the connection picker to select the exact destination. With both endpoints visible, the connector is solid. Close the finding's containing box and verify that the link is dashed and projected onto the visible box. Inspect it and jump to the exact endpoint. Add a **Port results** box inside the decision, move the finding into it, and verify that the same link still reaches the finding.
- [ ] Add a written answer box and mark it as the Question's **Derived result**. Give it a one-sentence draft using the Pastel finding. Verify navigation from the Question to the result and from the result to its supporting box.
- [ ] Save and name this version **Before Pastel review**. Reload and verify the box tree, links, answer, and version persist.
- [ ] Use the web UI to limit agent editing to the Pastel finding and the written answer. Leave an annotation on the finding asking the agent to explain why Pastel was dropped, and another on the answer requesting a sentence about the C front end. Save the project and review IDs shown by the UI.

## Run the review through the local MCP endpoint

Use Codex's one-run configuration override. Paste the project ID and review ID from the browser when prompted by the shell.

```sh
printf 'Project ID: '
read -r project_id
printf 'Review ID: '
read -r review_id
review_agent() {
  codex exec --ephemeral --ignore-user-config --sandbox read-only \
    -c 'mcp_servers.story_builder.url="http://127.0.0.1:4310/mcp"' --json "$@" </dev/null
}
review_agent "Use the Story Builder MCP tools for project $project_id and review $review_id. Start a session, read both notes and their target boxes, and show one representative breakdown. Ask whether to keep the stack figures in nested detail. Stop for input before applying changes."
```

- [ ] Confirm the CLI discovers Story Builder tools and calls `start_session`, `read_review`, and `read_canvas`. Each tool after session start uses the returned `session_id`. The agent shows a sample and asks about detail. The browser still shows the original story and open review.
- [ ] After approving the sample, run the edit below in the same terminal. The one-run approval applies to `apply_changes` on this disposable local server. Confirm a completed tool call in the CLI trace and matching edits in the browser. [Codex MCP settings](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

```sh
review_agent -c 'mcp_servers.story_builder.tools.apply_changes.approval_mode="approve"' \
  "Use the Story Builder MCP tools for project $project_id and review $review_id. The reviewer approved both notes. In the Pastel finding's text detail, explain that the target allowed 64 KB of stack and Pastel needed several megabytes. In the written answer, mention that Stallman reused the C front end and link to the finding. Apply the two agreed edits and resolve the two notes in one batch."
```

- [ ] Verify the finding contains both the stack detail and its nested event. The answer now mentions the reused front end, and the annotations point to the changes. Choose **Save**, then open History and name the resulting version **Explain why Pastel was dropped**. Compare it with **Before Pastel review** and check that both changes are visible.
- [ ] Continue from **Before Pastel review**. Add an alternate explanation and save it on the new branch. Verify both branches are present, each can be opened, and versions across branches can be compared.

## Check the editing boundaries

- [ ] With the agent locked, attempt a write and verify that the browser shows the original content. In add-only mode, verify that adding a box succeeds and editing an existing box or adding a connector is rejected. In selected-box mode, test a mixed batch containing one allowed and one locked edit. Verify the whole submitted batch is rejected and its annotations stay open.
- [ ] Have an agent read a revision. Before it writes, edit a different field in the browser. Verify both edits can land. Repeat with both editing the same field. Verify the response identifies the conflict and History preserves the earlier content.
- [ ] Verify manual Save flushes pending changes once. Repeat with an idle gap of five seconds. Then keep editing at intervals shorter than five seconds until thirty seconds have elapsed since the first unsaved edit. Check that a checkpoint appears at the cap and that the next edit starts a new window. Include one human edit and one agent batch before the same checkpoint and verify both contributors appear in History.
- [ ] Delete a box that contains a nested block linked from outside. Verify the preview identifies affected children and external links. After deletion, open the earlier version and verify the saved blocks and connector can be recovered by continuing from that version.

Record the branch and commit tested, browser and CLI results, and any failed checkpoint. A passing browser suite and a successful live CLI agent review are separate exit criteria.
