# Story Builder UI design

Build from the approved GCC canvas. The workspace should feel like a quiet drawing surface with legible reasoning blocks. Its central action is adding and connecting boxes. Agent settings, reviews, and history are available from the same workspace.

## Workspace layout

```text
┌───────────────────────────────────────────────────────────────────────────┐
│ Story Builder / Project name                    Save   Review   History   │
│ Project ID · Copy                                         Agent editing  │
├───────────────────────────────────────────────┬───────────────────────────┤
│ + Add box     Browse       Main canvas        │ Context panel             │
│                                               │                           │
│   [Question] ── answered by ──▶ [Reasoning]   │ Selected box, Review,     │
│                                        │      │ History, or Agent editing │
│   [Decision · Open] ◀──────────────────┘      │                           │
│                                               │                           │
└───────────────────────────────────────────────┴───────────────────────────┘
```

- Use a warm off-white canvas with a subtle 16 px dot grid, off-white cards, graphite text, and a dark green accent. Start with canvas `#f7f6f2`, card `#fffdfa`, text `#252523`, muted text `#615e55`, border `#dcd7cc`, accent `#256953`, and open box fill `#f2f8f3`. In dark mode use canvas `#1e1e1c`, card `#252421`, text `#f4efe6`, muted text `#c0b9ae`, border `#46423b`, accent `#a2d6bd`, and open box fill `#202c26`.
- Use system sans-serif, 20 px project titles, 14 px box titles, and secondary text at 12 px or larger. Use an 8 px spacing grid and 8 px card corners. Give each box type a small, labeled tint. Use the green accent for focus, selection, and actions. Render the direction and label of a connection independently of its color.
- The header holds the project name, project ID with a copy action, Save, Review, History, and Agent editing. The canvas toolbar holds Add box, Browse, and the current breadcrumb. A selection, Review, History, or Agent editing owns the single context panel. On desktop use a 320 px panel and let the canvas fill the remaining width. Closing a panel returns focus to its trigger.
- Start with a genuinely empty canvas. The workspace shows the normal toolbar and one centered **Add a box** action. Let the user choose any type and enter a title. After creating a box, bring it into view, select it, and focus its title button. Creating and editing boxes, connecting them, and viewing versions are normal web actions.

## Boxes, nesting, and connections

```text
  Main canvas / Write a new compiler
  ┌───────────────────────── Decision ───────────────────────────┐
  │ Can GNU reuse an existing compiler?                         │
  │         │                               │                    │
  │   Reuse VUCK                      Adapt Pastel               │
  │                                         │                    │
  │                   Pastel exceeds the stack limit · Open     │
  │                                         ┊                    │
  └─────────────────────────────────────────┊────────────────────┘
                                            │
                                  [Write GCC and reuse the front end]
```

- Show a closed box as its type and title, with an **Open box** action for content. Selecting it opens a panel with editable title, type, and text, plus actions for Open box, Connect, Annotate, and Delete. Support Shift-click to extend selection and checkbox selection in Browse. Put **Annotate selection** and selection sharing in the multi-select panel.
- Selected editable cards show a lower-right resize grip clear of the footer actions. Keep the upper-left corner anchored and preview the dimensions during the gesture. Save once on release. The inspector offers **Width**, **Minimum height**, and **Apply size**, including in the narrow list layout. Historical views show the recorded sizes.
- Use one visible right-edge connection handle on the selected canvas card. During a drag, distinguish valid destination cards from the current drop target. A valid drop opens the Connect dialog with both endpoints filled in and focus on **Relationship**. Escape, the backdrop, and the source box cancel the gesture. An outside-box reference connects to its real block ID.
- Open a box in an inset canvas with a breadcrumb, a clear close action, content text when present, and its child boxes. Keep the outside canvas visible for context. Use the same inset when opening a deeper box and update the breadcrumb. Restore the previous focus and canvas position on close. In the GCC example, the Pastel finding stays short until the reader opens it to see the 64 KB stack budget.
- Draw visible-to-visible connectors as solid arrows. Project each hidden endpoint to its nearest visible ancestor and dash the path if either endpoint is projected. Omit a connector when both endpoints project to the same box. Group dashed connectors that share visible endpoints and direction. Show their count where they join, and keep solid connectors separately inspectable.
- Selecting a connector opens its label and exact source and destination paths. A grouped connector lists its individual links. **Jump to source** and **Jump to destination** open the necessary ancestors, reveal the actual box, and focus it.
- **Connect** is available on the selected card for keyboard and touch use. It holds the source in the dialog header and presents destinations as a collapsible tree rooted at Main canvas. Show the selected destination path and direction before saving. Opening and closing branches in the tree keeps the source selection fixed.
- For a nested deletion, list affected descendants and connections that cross the deleted boundary before confirmation. Keep Cancel in the default focus position. Use History to recover an earlier canvas.

## Review, history, and written answers

| Surface | Design and states |
| --- | --- |
| **Review** | Show a list of annotations with target titles and paths. Jumping to a target opens its ancestors. Annotate one or several selected boxes, then use **Copy for agent** to copy the project, review, and starting-state identifiers. Distinguish Open, Applied, and Needs input or unlock with text. Applied notes link to their changes. Keep unresolved notes visible. |
| **Agent editing** | Offer Locked, Selected boxes, Add boxes only, and Full editing. In Selected boxes, list the specific unlocked boxes. Show scope at the top of the panel and expose connector restrictions near the action. A blocked agent edit surfaces the affected box or connector with a jump action and leaves the note open. |
| **History** | Show a version graph with names, contributor labels, and current branch. Accompany the graph with keyboard-navigable version rows. A historical view has a visible **Viewing version** indicator and **Continue from here** to create a branch. **Compare** lets the user pick two versions and shows changes on canvas with a textual list for additions, removals, moves, and edits. Use a count on a closed box to reach its hidden changes. |
| **Saving and conflicts** | Show pending writes as Saving and a committed checkpoint as Saved. A conflict shows the two changes and links to the affected blocks. The user can reconcile them in the working branch or keep the alternate version in a separate branch. |
| **Derived result** | A Question offers **Open result** after the writer designates a box. The result links back to its Question and supports writing and annotation as a regular box. Allow a sentence to link to a supporting box. Activating that link reveals and focuses the target. A request to revise the result goes through Review. |

## Responsive and interaction checks

- Below 760 px, wrap header actions and show panels as full-width sheets with a clear back or close control. Keep Browse within reach as a vertical, selectable list of box titles and relationship text. Make editing, connecting, annotating, and comparing possible from that list at 320 px wide.
- Use semantic buttons, inputs, labeled dialogs, and a visible focus indicator. Tab reaches the canvas toolbar, box list, connection picker, panel controls, and History. Enter activates the focused item and Escape dismisses the innermost open view, with focus returned to its trigger. Offer buttons for selection and connections wherever a pointer gesture is available.
- Use at least 44 px touch targets in narrow layouts. Test light and dark foregrounds against their actual surfaces. Place pending, applied, conflict, and saved states in text and announce changes to save or review status in a polite live region.
- Capture at 1440, 768, and 320 px using local headless Chromium. Run one keyboard-only walkthrough from the empty project through Add box, Connect, annotate, compare, and jump to a nested source. Verify solid and dashed links, independent access to grouped endpoints, and the nested delete impact preview.

## Design sign-off

The lead reviews the layout and interaction decisions before implementation. The designer pairs with the implementation engineer on spacing, responsive sheets, the box and connector states, and the History change presentation. The designer checks the running implementation against local headless captures and flags interaction or visual issues for the engineer. The lead approves the running UI and the code after independent engineering review and resolution of findings.
