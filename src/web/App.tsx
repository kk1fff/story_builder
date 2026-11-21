import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { getBoxSize, type Box, type Connector, type DeleteImpact, type Operation, type Project, type Review, type StorySnapshot, type Version, type WorkingStory } from '../shared/story.js';
import { AgentPanel, BrowsePanel, HistoryPanel, ReviewPanel, type DraftNote } from './Panels.js';
import { BoxForm, BoxPicker, BoxSizeForm, ConnectorForm, Dialog, WrittenText, boxPath, locationName, titleCase } from './components.js';
import { branchPath, projectPath, request, RequestError, type AppliedEdit, type Difference, type History } from './api.js';
import { findBoxPosition } from './graph.js';

const Board = lazy(() => import('./Canvas.js').then(module => ({ default: module.Board })));

type Panel = 'inspect' | 'browse' | 'review' | 'history' | 'agent' | 'connections';
type Modal =
  | { kind: 'add'; parentId: string | null; id: string; base: string; position: { x: number; y: number } }
  | { kind: 'edit' | 'connect' | 'move' | 'result'; box: Box; base: string; newConnectorId: string; targetId?: string }
  | { kind: 'annotate'; ids: string[] }
  | { kind: 'delete'; box: Box; impact: DeleteImpact & { revisionId: string } }
  | { kind: 'connector'; connector: Connector; base: string };

function reason(error: unknown) {
  return error instanceof Error ? error.message : 'The story could not be loaded.';
}

function newId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [story, setStory] = useState<WorkingStory | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  function remember(projectId?: string, branchId?: string) {
    const url = new URL(location.href);
    url.search = '';
    if (projectId) url.searchParams.set('project', projectId);
    if (branchId) url.searchParams.set('branch', branchId);
    window.history.replaceState({}, '', url);
  }

  useEffect(() => {
    const query = new URLSearchParams(location.search);
    const id = query.get('project');
    request<Project[]>('/api/projects').then(async items => {
      setProjects(items);
      const project = items.find(item => item.id === id);
      if (project) {
        setStory(await request<WorkingStory>(branchPath(project.id, query.get('branch') || project.defaultBranchId)));
      }
    }).catch(error => setError(reason(error))).finally(() => setLoading(false));
  }, []);

  async function activate(action: () => Promise<WorkingStory>) {
    setBusy(true);
    setError('');
    try {
      const loaded = await action();
      setStory(loaded);
      setProjects(current => current.some(item => item.id === loaded.project.id) ? current : [loaded.project, ...current]);
      remember(loaded.project.id, loaded.branch.id);
      setName('');
    } catch (error) { setError(reason(error)); }
    finally { setBusy(false); }
  }

  if (story) return <Workspace key={story.project.id} initial={story}
    leave={() => { setStory(null); remember(); }} remember={branchId => remember(story.project.id, branchId)} />;
  return <main className="project-lobby">
    <div className="brand-lockup"><span className="brand-mark" aria-hidden="true">◇</span><span>Story Builder</span></div>
    <div className="lobby-grid">
      <section className="lobby-intro">
        <h1>Where a story takes shape.</h1>
        <p>Build a canvas of questions, decisions, and the reasoning that connects them.</p>
      </section>
      <section className="lobby-projects">
        <h2>Projects</h2>
        <form className="form-stack" onSubmit={event => {
          event.preventDefault();
          if (name.trim()) void activate(() => request('/api/projects', 'POST', { name: name.trim() }));
        }}>
          <label className="field">Project name<input autoFocus value={name} onChange={event => setName(event.target.value)} maxLength={200} required /></label>
          <button className="button-primary" disabled={busy || !name.trim()}>Create project</button>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
        {loading && <p className="muted" role="status">Loading projects…</p>}
        <ul className="project-list">{projects.map(project => <li key={project.id}>
          <button type="button" disabled={busy} onClick={() => void activate(() => request(branchPath(project.id, project.defaultBranchId)))}>{project.name}<span aria-hidden="true">↗</span></button>
        </li>)}</ul>
      </section>
    </div>
  </main>;
}

function Workspace({ initial, leave, remember }: { initial: WorkingStory; leave: () => void; remember: (branchId: string) => void }) {
  const [live, setLive] = useState(initial);
  const [historical, setHistorical] = useState<{ story: WorkingStory; version: Version } | null>(null);
  const [history, setHistory] = useState<History>();
  const [difference, setDifference] = useState<(Difference & { before: StorySnapshot; after: StorySnapshot }) | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [drafts, setDrafts] = useState<DraftNote[]>([]);
  const [parentId, setParent] = useState<string | null>(null);
  const [revealBoxId, setRevealBoxId] = useState<string>();
  const [selected, setSelected] = useState<string[]>([]);
  const [connectorIds, setConnectorIds] = useState<string[]>([]);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [value, setValue] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<RequestError | Error | null>(null);
  const [copyText, setCopyText] = useState('');
  const generation = useRef(0);
  const moves = useRef(new Map<string, { revisionId: string; parentId: string | null }>());
  const receipts = useRef(new Map<string, string>());
  const canvas = useRef<HTMLElement>(null);
  const inspector = useRef<HTMLElement>(null);

  const { project, branch } = live;
  const current = historical?.story ?? live;
  const { boxes, connectors } = current.snapshot;
  const prefix = branchPath(project.id, branch.id);
  const base = projectPath(project.id);
  const readonly = historical !== null;
  const visibleParentId = parentId && Object.hasOwn(boxes, parentId) ? parentId : null;
  const chosen = selected.filter(id => Object.hasOwn(boxes, id));
  const single = chosen.length === 1 ? boxes[chosen[0]!] : undefined;
  const head = history?.versions.find(version => version.id === branch.headVersionId);
  const changed = Boolean(head && head.revisionId !== live.revisionId);

  useEffect(() => {
    let mounted = true;
    async function poll() {
      const ticket = generation.current;
      try {
        const next = await request<WorkingStory>(prefix);
        if (!mounted || generation.current !== ticket) return;
        setLive(previous => previous.revisionId === next.revisionId && previous.branch.headVersionId === next.branch.headVersionId &&
          JSON.stringify(previous.policy) === JSON.stringify(next.policy) ? previous : next);
        if (panel === 'history' || !history || next.branch.headVersionId !== live.branch.headVersionId) {
          const listing = await request<History>(`${base}/history`);
          if (mounted && generation.current === ticket) setHistory(listing);
        }
        if (panel === 'review') {
          const listing = await request<Review[]>(`${prefix}/reviews`);
          if (mounted && generation.current === ticket) setReviews(listing);
        }
      } catch (error) {
        if (mounted && generation.current === ticket) setError(error instanceof Error ? error : new Error(reason(error)));
      }
    }
    if (!busy) {
      void poll();
      const timer = setInterval(poll, 1000);
      return () => { mounted = false; clearInterval(timer); };
    }
  }, [prefix, base, panel, busy, Boolean(history), live.branch.headVersionId]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || modal || copyText) return;
      const target = event.target;
      if (target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (panel) setPanel(null);
      else if (visibleParentId) setParent(boxes[visibleParentId].parentId);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [modal, copyText, panel, visibleParentId, boxes]);

  async function perform(task: () => Promise<void>) {
    generation.current++;
    setBusy(true);
    setError(null);
    try { await task(); }
    catch (error) { setError(error instanceof Error ? error : new Error(reason(error))); }
    finally { setBusy(false); }
  }

  async function refresh() {
    const [next, listing] = await Promise.all([request<WorkingStory>(prefix), request<History>(`${base}/history`)]);
    setLive(next);
    setHistory(listing);
  }

  async function write(operations: Operation[], revision = live.revisionId) {
    const fingerprint = JSON.stringify([branch.id, revision, operations]);
    const requestId = receipts.current.get(fingerprint) ?? newId();
    receipts.current.set(fingerprint, requestId);
    let applied: AppliedEdit;
    try {
      applied = await request<AppliedEdit>(`${prefix}/changes`, 'POST', { baseRevisionId: revision, requestId, operations });
    } catch (error) {
      if (error instanceof RequestError) receipts.current.delete(fingerprint);
      throw error;
    }
    receipts.current.delete(fingerprint);
    setLive(previous => previous.branch.id === applied.branch.id &&
      (previous.revisionId === revision || previous.revisionId === applied.revisionId)
      ? { ...previous, branch: applied.branch, revisionId: applied.revisionId, snapshot: applied.snapshot }
      : previous);
    setMessage('Canvas updated');
  }

  function selectBox(id: string, extend: boolean) {
    setSelected(current => extend ? current.includes(id) ? current.filter(item => item !== id) : [...current, id] : [id]);
    if (!extend || panel !== 'browse') setPanel('inspect');
  }

  function openBox(id: string) {
    if (!Object.hasOwn(boxes, id)) return;
    setParent(id);
    setSelected([]);
  }

  function jump(id: string) {
    if (!Object.hasOwn(boxes, id)) { setMessage('This supporting box is absent from the viewed version.'); return; }
    setParent(boxes[id].parentId);
    selectBox(id, false);
  }

  function begin(kind: 'edit' | 'connect' | 'move' | 'result', box: Box, targetId?: string, revisionId = live.revisionId) {
    setValue(kind === 'move' ? box.parentId : kind === 'result' ? box.derivedResultId : null);
    setModal({ kind, box, base: revisionId, newConnectorId: newId(), targetId });
  }

  function connectBox(sourceId: string, targetId?: string, revisionId?: string) {
    if (readonly || !Object.hasOwn(boxes, sourceId) || (targetId && !Object.hasOwn(boxes, targetId))) return;
    begin('connect', boxes[sourceId], targetId, revisionId);
  }

  async function resizeBox(boxId: string, size: ReturnType<typeof getBoxSize>, revisionId: string) {
    if (readonly) return false;
    let saved = false;
    await perform(async () => {
      await write([{ op: 'resize_box', boxId, ...size }], revisionId);
      saved = true;
    });
    return saved;
  }

  function focusSize(boxId: string) {
    selectBox(boxId, false);
    requestAnimationFrame(() => inspector.current?.querySelector<HTMLInputElement>('[data-box-size-width]')?.focus());
  }

  const add = () => setModal({
    kind: 'add', parentId: visibleParentId, id: newId(), base: live.revisionId, position: positioned(visibleParentId),
  });
  const annotate = () => { setNoteText(''); setModal({ kind: 'annotate', ids: chosen }); };
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setMessage('Copied to clipboard'); }
    catch { setCopyText(text); }
  }
  function handoff(review?: Review, ids?: string[]) {
    const scope = review ? `Read review ${review.id} and work through its annotations.`
      : ids?.length ? `Focus on ${ids.map(id => `${locationName(boxes, id)} (${id})`).join(', ')}.` : 'Open the project.';
    void copy(`Connect to Story Builder at ${location.origin}/mcp. Start a session for project ${project.id} on branch ${branch.id}. ${scope}`);
  }

  async function viewVersion(version: Version, target?: string) {
    const story = await request<WorkingStory>(`${branchPath(project.id, version.branchId)}?versionId=${encodeURIComponent(version.id)}`);
    setHistorical({ story, version });
    const targetBox = target ? story.snapshot.boxes[target] : undefined;
    setParent(targetBox?.parentId ?? null);
    setSelected(targetBox ? [targetBox.id] : []);
    return story;
  }

  function returnToLive(branchId = branch.id) {
    void perform(async () => {
      const story = await request<WorkingStory>(branchPath(project.id, branchId));
      if (branchId !== branch.id) {
        setDrafts([]);
      }
      setLive(story); setHistorical(null); setDifference(null); setParent(null); setSelected([]);
      remember(branchId);
    });
  }

  function positioned(parentId: string | null, moving?: Box) {
    const heights = new Map<string, number>();
    for (const card of canvas.current?.querySelectorAll<HTMLElement>('[data-box-id]') ?? []) {
      if (card.dataset.boxId && card.offsetHeight) heights.set(card.dataset.boxId, card.offsetHeight);
    }
    return findBoxPosition(boxes, parentId, { moving, measuredHeights: heights });
  }

  const changeKinds: Record<string, 'added' | 'removed' | 'changed' | 'moved'> = {};
  const connectorChangeKinds: Record<string, 'added' | 'removed' | 'changed'> = {};
  const nestedChangeCounts: Record<string, number> = {};
  if (difference) {
    for (const box of difference.boxes.added) changeKinds[box.id] = 'added';
    for (const box of difference.boxes.removed) changeKinds[box.id] = 'removed';
    for (const { after, fields } of difference.boxes.changed) {
      changeKinds[after.id] = fields.every(field => ['parentId', 'x', 'y'].includes(field)) ? 'moved' : 'changed';
    }
    for (const link of difference.connectors.added) connectorChangeKinds[link.id] = 'added';
    for (const link of difference.connectors.removed) connectorChangeKinds[link.id] = 'removed';
    for (const { after } of difference.connectors.changed) connectorChangeKinds[after.id] = 'changed';
    const allBoxes = { ...Object.fromEntries(difference.boxes.removed.map(box => [box.id, box])), ...boxes };
    for (const id of Object.keys(changeKinds)) {
      for (const ancestor of boxPath(allBoxes, id).slice(0, -1)) nestedChangeCounts[ancestor.id] = (nestedChangeCounts[ancestor.id] ?? 0) + 1;
    }
  }

  let panelTitle: string | undefined;
  let content: React.ReactNode;
  if (panel === 'inspect' && single) {
    panelTitle = single.title;
    const question = Object.values(boxes).find(box => box.derivedResultId === single.id);
    content = <div className="form-stack">
      <span className="badge">{titleCase(single.type)}</span>
      {question && <div className="panel-item"><span className="badge">Derived result</span> <button type="button" className="text-link" onClick={() => jump(question.id)}>{question.title}</button></div>}
      {single.body && <WrittenText body={single.body} jump={jump} />}
      {!readonly && <BoxSizeForm key={single.id} box={single} revisionId={live.revisionId} busy={busy}
        save={(size, revisionId) => resizeBox(single.id, size, revisionId)} />}
      <div className="panel-actions">
        <button type="button" onClick={() => openBox(single.id)}>Open box</button>
        {single.derivedResultId && <button type="button" onClick={() => jump(single.derivedResultId!)}>Open result</button>}
        {!readonly && <>
          <button type="button" onClick={() => begin('edit', single)}>Edit box</button>
          <button type="button" onClick={() => begin('connect', single)}>Connect</button>
          <button type="button" onClick={() => begin('move', single)}>Move to box</button>
          {single.type === 'question' && <button type="button" onClick={() => begin('result', single)}>Set derived result</button>}
          <button type="button" onClick={annotate}>Annotate</button>
          <button type="button" onClick={() => handoff(undefined, chosen)}>Share selection</button>
          <button type="button" className="danger" onClick={() => void perform(async () => {
            const impact = await request<DeleteImpact & { revisionId: string }>(`${prefix}/delete-impact/${single.id}`);
            setModal({ kind: 'delete', box: single, impact });
          })}>Delete box</button>
        </>}
      </div>
    </div>;
  } else if (panel === 'inspect' && chosen.length > 1) {
    panelTitle = `${chosen.length} boxes selected`;
    content = <div className="form-stack"><ul>{chosen.map(id => <li key={id}>{locationName(boxes, id)}</li>)}</ul>
      {!readonly && <div className="panel-actions"><button type="button" onClick={annotate}>Annotate selection</button><button type="button" onClick={() => handoff(undefined, chosen)}>Share selection</button></div>}
    </div>;
  } else if (panel === 'browse') {
    panelTitle = 'Browse boxes';
    content = <BrowsePanel boxes={boxes} selected={chosen} select={selectBox} jump={jump} add={readonly ? undefined : add} />;
  } else if (panel === 'review') {
    panelTitle = 'Review';
    content = <ReviewPanel drafts={drafts} reviews={reviews} boxes={boxes} busy={busy || readonly} remove={index => {
      setDrafts(current => current.filter((_, i) => i !== index));
    }} send={() => void perform(async () => {
      const reviewed = await request<WorkingStory>(prefix);
      const missing = drafts.find(note => note.boxIds.some(id => !Object.hasOwn(reviewed.snapshot.boxes, id)));
      if (missing) throw new Error(`A target of “${missing.text}” was deleted. Remove that note to create the review.`);
      const saved = await request<Review>(`${prefix}/reviews`, 'POST', { baseRevisionId: reviewed.revisionId, notes: drafts });
      setReviews(previous => [saved, ...previous]);
      setDrafts([]); setMessage('Review created');
    })} copy={handoff} jump={jump} />;
  } else if (panel === 'agent') {
    panelTitle = 'Agent editing';
    content = <AgentPanel key={JSON.stringify(live.policy)} policy={live.policy} boxes={live.snapshot.boxes} selected={chosen} busy={busy} copy={() => handoff()} save={policy => void perform(async () => {
      await request(`${base}/agent-editing`, 'PUT', policy); await refresh(); setMessage('Agent permissions saved');
    })} />;
  } else if (panel === 'history') {
    panelTitle = 'History';
    content = <HistoryPanel history={history} viewed={historical?.version ?? null} difference={difference} busy={busy} currentBranch={branch.id}
      view={version => void perform(async () => { setDifference(null); await viewVersion(version); })}
      compare={(fromVersionId, toVersionId) => void perform(async () => {
        const result = await request<Difference>(`${base}/compare?fromVersionId=${encodeURIComponent(fromVersionId)}&toVersionId=${encodeURIComponent(toVersionId)}`);
        const before = await request<WorkingStory>(`${branchPath(project.id, result.from.branchId)}?versionId=${encodeURIComponent(result.from.id)}`);
        const after = await viewVersion(result.to);
        setDifference({ ...result, before: before.snapshot, after: after.snapshot });
      })}
      onChange={(id, version) => void perform(async () => { await viewVersion(version, id); })}
      onConnectionChange={(link, version) => void perform(async () => {
        await viewVersion(version, link.sourceId);
        setConnectorIds([link.id]);
        setPanel('connections');
      })}
      rename={(version, name) => void perform(async () => {
        const renamed = await request<Version>(`${base}/versions/${version.id}`, 'PATCH', { name });
        setHistorical(current => current ? { ...current, version: renamed } : current);
        await refresh();
      })}
      fork={(version, name) => void perform(async () => {
        const forked = await request<WorkingStory['branch']>(`${base}/branches`, 'POST', { versionId: version.id, name });
        const story = await request<WorkingStory>(branchPath(project.id, forked.id));
        setLive(story); setHistorical(null); setDifference(null); setSelected([]); setParent(null);
        setDrafts([]); remember(forked.id);
      })} live={returnToLive} />;
  } else if (panel === 'connections') {
    panelTitle = connectorIds.length === 1 ? 'Connection' : `${connectorIds.length} connections`;
    content = <div className="form-stack">{connectorIds.flatMap(id => Object.hasOwn(connectors, id) ? [connectors[id]] : []).map(connector =>
      <article key={connector.id} className="panel-item form-stack">
        <h3>{connector.label}</h3>
        <p>{locationName(boxes, connector.sourceId)} → {locationName(boxes, connector.targetId)}</p>
        {connector.reverseLabel && <p className="muted">Reverse · {connector.reverseLabel}</p>}
        <div className="panel-actions">
          <button type="button" onClick={() => jump(connector.sourceId)}>Jump to source</button>
          <button type="button" onClick={() => jump(connector.targetId)}>Jump to destination</button>
          {!readonly && <button type="button" onClick={() => setModal({ kind: 'connector', connector, base: live.revisionId })}>Edit connection</button>}
        </div>
      </article>,
    )}</div>;
  }

  const crumbs = visibleParentId ? boxPath(boxes, visibleParentId) : [];
  const alertBody = error && <>
    <span>{error.message}</span>
    {error instanceof RequestError && error.details != null && <details><summary>Details</summary><pre>{JSON.stringify(error.details, null, 2)}</pre></details>}
    <button type="button" onClick={() => setError(null)}>Dismiss</button>
  </>;
  return <main className="app-shell">
    <header className="app-header">
      <div className="brand-lockup"><button type="button" className="brand-mark button-quiet" aria-label="Projects" onClick={leave}>◇</button><div><span className="muted">Story Builder / {branch.name}</span><h1>{project.name}</h1></div></div>
      <div className="header-actions">
        <button type="button" title={project.id} aria-label="Copy project ID" onClick={() => void copy(project.id)}>Project ID · {project.id.slice(0, 7)}</button>
        <button type="button" disabled={busy || readonly} onClick={() => void perform(async () => {
          await request(`${prefix}/save`, 'POST', {}); await refresh(); setMessage('Saved');
        })}>Save</button>
        <button type="button" aria-pressed={panel === 'review'} onClick={() => setPanel(panel === 'review' ? null : 'review')}>Review</button>
        <button type="button" aria-pressed={panel === 'history'} onClick={() => setPanel(panel === 'history' ? null : 'history')}>History</button>
        <button type="button" aria-pressed={panel === 'agent'} onClick={() => setPanel(panel === 'agent' ? null : 'agent')}>Agent editing</button>
      </div>
    </header>

    <div className="workspace">
      <section className="canvas-column" aria-label="Story canvas" ref={canvas}>
        <div className="canvas-toolbar">
          <div className="panel-actions">
            {!readonly && <button type="button" className="button-primary" onClick={add}>Add box</button>}
            <button type="button" aria-pressed={panel === 'browse'} onClick={() => setPanel(panel === 'browse' ? null : 'browse')}>Browse</button>
          </div>
          <nav className="breadcrumbs" aria-label="Canvas path">
            <button type="button" onClick={() => { setParent(null); setSelected([]); }}>Main canvas</button>
            {crumbs.map((box, index) => <span key={box.id}>› {index === crumbs.length - 1
              ? <strong>{box.title}</strong>
              : <button type="button" onClick={() => openBox(box.id)}>{box.title}</button>}</span>)}
          </nav>
          <span className="muted" aria-live="polite">{historical ? `Viewing version · ${historical.version.name}` : busy ? 'Saving…' : changed ? 'Working changes' : 'Saved'}{message && ` · ${message}`}</span>
        </div>
        {visibleParentId && <div className="inset-header"><div><span className="badge">{titleCase(boxes[visibleParentId].type)}</span> <strong>{boxes[visibleParentId].title}</strong>
          {boxes[visibleParentId].body && <WrittenText body={boxes[visibleParentId].body} jump={jump} />}</div>
          <button type="button" onClick={() => { setParent(boxes[visibleParentId].parentId); selectBox(visibleParentId, false); }}>Close box</button>
        </div>}
        <Suspense fallback={<p className="muted" role="status">Loading canvas…</p>}><Board snapshot={current.snapshot} activeParentId={visibleParentId} selectedIds={chosen} readOnly={readonly}
          revisionId={live.revisionId} revealBoxId={revealBoxId} onRevealBox={id => setRevealBoxId(current => current === id ? undefined : current)}
          connectBox={connectBox} resizeBox={resizeBox} focusSize={focusSize}
          selectBox={selectBox} openBox={openBox} beginMoveBox={boxId => {
            const box = live.snapshot.boxes[boxId];
            if (box) moves.current.set(boxId, { revisionId: live.revisionId, parentId: box.parentId });
          }} moveBox={(boxId, position) => {
            const base = moves.current.get(boxId);
            moves.current.delete(boxId);
            if (base) void perform(() => write([{ op: 'move_box', boxId, parentId: base.parentId, ...position }], base.revisionId));
          }} inspectConnector={ids => { setConnectorIds(ids); setPanel('connections'); }}
          addBox={readonly ? undefined : add} changeKinds={changeKinds} connectorChangeKinds={connectorChangeKinds} nestedChangeCounts={nestedChangeCounts} /></Suspense>
      </section>
      {panelTitle && <aside className="context-panel" aria-label={panelTitle} ref={inspector}>
        <div className="panel-header"><h2>{panelTitle}</h2><button type="button" aria-label="Close panel" className="button-quiet" onClick={() => setPanel(null)}>×</button></div>
        <div className="panel-body">{content}</div>
      </aside>}
    </div>
    {error && !modal && <div className="error error-toast" role="alert">{alertBody}</div>}
    {copyText && <Dialog title="Copy for agent" close={() => setCopyText('')}><label className="field">Agent instructions<textarea rows={6} value={copyText} readOnly data-initial-focus onFocus={event => event.target.select()} /></label></Dialog>}
    {modal && <Dialog title={{ add: 'Add box', edit: 'Edit box', connect: 'Connect', move: 'Move to box', result: 'Set derived result', annotate: 'Annotate', delete: 'Delete box', connector: 'Edit connection' }[modal.kind]} close={() => setModal(null)}>
      {error && <div className="error panel-item" role="alert">
        {alertBody}
        {error instanceof RequestError && error.code === 'conflict' && 'base' in modal &&
          <button type="button" onClick={() => void perform(async () => {
            const latest = await request<WorkingStory>(prefix);
            setLive(latest);
            setModal({ ...modal, base: latest.revisionId });
          })}>Keep draft against latest revision</button>}
      </div>}
      {modal.kind === 'add' && <BoxForm busy={busy} submitLabel="Add box" onSave={fields => perform(async () => {
        await write([{ op: 'add_box', box: { id: modal.id, parentId: modal.parentId, ...fields, ...modal.position } }], modal.base);
        setModal(null); selectBox(modal.id, false); setRevealBoxId(modal.id);
      })} />}
      {modal.kind === 'edit' && <BoxForm busy={busy} box={modal.box} submitLabel="Save box" onSave={fields => perform(async () => {
        const patch = Object.fromEntries(Object.entries(fields).filter(([key, value]) => value !== modal.box[key as keyof Box]));
        if (Object.keys(patch).length) await write([{ op: 'update_box', boxId: modal.box.id, patch }], modal.base);
        setModal(null);
      })} />}
      {modal.kind === 'connect' && <ConnectorForm boxes={boxes} source={modal.box} initialTargetId={modal.targetId} busy={busy} onSave={(targetId, label, reverseLabel) => void perform(async () => {
        await write([{ op: 'add_connector', connector: { id: modal.newConnectorId, sourceId: modal.box.id, targetId, label, reverseLabel } }], modal.base);
        setModal(null);
      })} />}
      {(modal.kind === 'move' || modal.kind === 'result') && <div className="form-stack">
        <BoxPicker boxes={boxes} value={value} root={modal.kind === 'move'} onPick={setValue} excluded={modal.kind === 'move' ? [modal.box.id] : []} />
        {modal.kind === 'result' && <button type="button" aria-pressed={value === null} onClick={() => setValue(null)}>Clear result</button>}
        <button type="button" className="button-primary" disabled={busy || value === modal.box.id} onClick={() => void perform(async () => {
          if (modal.kind === 'move') {
            await write([{ op: 'move_box', boxId: modal.box.id, parentId: value, ...positioned(value, modal.box) }], modal.base);
            setParent(value);
          } else {
            await write([{ op: 'set_derived_result', questionId: modal.box.id, resultId: value }], modal.base);
          }
          setModal(null);
        })}>{modal.kind === 'move' ? 'Move box' : 'Mark result'}</button>
      </div>}
      {modal.kind === 'annotate' && <form className="form-stack" onSubmit={event => {
        event.preventDefault();
        if (!noteText.trim()) return;
        setDrafts(previous => [...previous, { boxIds: modal.ids, text: noteText.trim() }]);
        setModal(null); setPanel('review');
      }}>
        <p className="muted">{modal.ids.map(id => locationName(boxes, id)).join(' · ')}</p>
        <label className="field">Annotation<textarea data-initial-focus required rows={5} maxLength={12_000} value={noteText} onChange={event => setNoteText(event.target.value)} /></label>
        <button className="button-primary" disabled={!noteText.trim()}>Add annotation</button>
      </form>}
      {modal.kind === 'delete' && <div className="form-stack">
        <p>Delete {modal.box.title} and its affected items?</p>
        <h3>Boxes</h3><ul>{modal.impact.boxIds.map(id => <li key={id}>{locationName(boxes, id)}</li>)}</ul>
        <h3>Connections</h3><ul>{modal.impact.connectorIds.map(id => {
          const link = connectors[id];
          return link && <li key={id}>{locationName(boxes, link.sourceId)} → {link.label} → {locationName(boxes, link.targetId)}</li>;
        })}</ul>
        {modal.impact.questionIds.length > 0 && <p>Derived result marks affected · {modal.impact.questionIds.map(id => locationName(boxes, id)).join(', ')}</p>}
        <div className="panel-actions"><button type="button" data-initial-focus onClick={() => setModal(null)}>Cancel</button>
          <button type="button" className="danger" disabled={busy} onClick={() => void perform(async () => {
            await write([{ op: 'delete_box', boxId: modal.box.id }], modal.impact.revisionId);
            setModal(null); setSelected([]);
          })}>Confirm deletion</button></div>
      </div>}
      {modal.kind === 'connector' && <form className="form-stack" onSubmit={event => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void perform(async () => {
          await write([{ op: 'update_connector', connectorId: modal.connector.id, patch: { label: String(data.get('label')).trim(), reverseLabel: String(data.get('reverse')).trim() || null } }], modal.base);
          setModal(null);
        });
      }}>
        <label className="field">Relationship<input required name="label" defaultValue={modal.connector.label} maxLength={120} /></label>
        <label className="field">Reverse label<input name="reverse" defaultValue={modal.connector.reverseLabel ?? ''} maxLength={120} /></label>
        <button className="button-primary" disabled={busy}>Save connection</button>
        <button type="button" className="danger" disabled={busy} onClick={() => void perform(async () => {
          await write([{ op: 'delete_connector', connectorId: modal.connector.id }], modal.base); setModal(null); setPanel(null);
        })}>Delete connection</button>
      </form>}
    </Dialog>}
  </main>;
}
