import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { AgentPolicy, Connector, Review, StorySnapshot, Version } from '../shared/story.js';
import type { Difference, History } from './api.js';
import { locationName, titleCase } from './components.js';

export function BrowsePanel({ boxes, selected, select, jump, add }: {
  boxes: StorySnapshot['boxes']; selected: string[]; select: (id: string, extend: boolean) => void; jump: (id: string) => void;
  add?: () => void;
}) {
  function branch(parent: string | null) {
    return <ul className="box-picker-tree">{Object.values(boxes).filter(box => box.parentId === parent).map(box =>
      <li key={box.id}>
        <div className="picker-row">
          <input type="checkbox" aria-label={`Select ${box.title}`} checked={selected.includes(box.id)} onChange={() => select(box.id, true)} />
          <button type="button" className="picker-box" onClick={() => jump(box.id)}>{box.title}<small>{titleCase(box.type)}</small></button>
        </div>
        {Object.values(boxes).some(child => child.parentId === box.id) && branch(box.id)}
      </li>,
    )}</ul>;
  }
  return Object.keys(boxes).length ? branch(null) : <p className="muted">The main canvas is empty. {add && <button type="button" className="text-link" onClick={add}>Add a box</button>}</p>;
}

export type DraftNote = { boxIds: string[]; text: string };

export function ReviewPanel({ drafts, reviews, boxes, busy, remove, send, copy, jump }: {
  drafts: DraftNote[]; reviews: Review[]; boxes: StorySnapshot['boxes']; busy: boolean;
  remove: (index: number) => void; send: () => void; copy: (review: Review) => void; jump: (id: string) => void;
}) {
  function targets(ids: string[]) {
    return <div className="chip-list">{ids.map(id => <button type="button" className="text-link" key={id} disabled={!boxes[id]} onClick={() => jump(id)}>{locationName(boxes, id)}</button>)}</div>;
  }
  return <div className="form-stack">
    {!drafts.length && !reviews.length && <p className="muted">Select one or more boxes and annotate them to prepare a review.</p>}
    {drafts.length > 0 && <section className="form-stack" aria-label="Draft annotations">
      <h3>Draft annotations</h3>
      {drafts.map((note, index) => <article className="panel-item" key={index}>
        <p>{note.text}</p>{targets(note.boxIds)}
        <button type="button" className="button-quiet" onClick={() => remove(index)}>Remove note</button>
      </article>)}
      <button type="button" className="button-primary" disabled={busy} onClick={send}>Create review</button>
    </section>}
    {reviews.map(review => <section className="form-stack" key={review.id} aria-label="Saved review" data-review-id={review.id}>
      <div className="inline-between"><h3>{new Date(review.createdAt).toLocaleString()}</h3><button type="button" onClick={() => copy(review)}>Copy for agent</button></div>
      {review.notes.map(note => <article key={note.id} className="panel-item">
        <span className="badge">{note.appliedRevisionId ? 'Applied' : 'Open'}</span>
        <p>{note.text}</p>{targets(note.boxIds)}
        {note.appliedRevisionId && <small className="muted">Revision {note.appliedRevisionId.slice(0, 8)}</small>}
      </article>)}
    </section>)}
  </div>;
}

const accessModes = [
  ['locked', 'Locked', 'Read the story and its reviews.'],
  ['selected', 'Selected boxes', 'Edit the specific boxes you unlock.'],
  ['add_only', 'Add boxes only', 'Create boxes on the canvas.'],
  ['full', 'Full editing', 'Edit boxes, connections, and written results.'],
] as const;

export function AgentPanel({ policy, boxes, selected, busy, save, copy }: {
  policy: AgentPolicy; boxes: StorySnapshot['boxes']; selected: string[]; busy: boolean;
  save: (policy: AgentPolicy) => void; copy: () => void;
}) {
  const [mode, setMode] = useState(policy.mode);
  const [allowed, setAllowed] = useState(policy.boxIds);
  return <form className="form-stack" onSubmit={event => { event.preventDefault(); save({ mode, boxIds: mode === 'selected' ? allowed : [] }); }}>
    <fieldset className="choice-list"><legend>Agent edit access</legend>
      {accessModes.map(([value, label, detail]) => <label key={value} className="choice-row">
        <input name="agent-mode" type="radio" value={value} checked={mode === value} onChange={() => { setMode(value); if (value === 'selected' && allowed.length === 0) setAllowed(selected); }} />
        <span><strong>{label}</strong><small>{detail}</small></span>
      </label>)}
    </fieldset>
    {mode === 'selected' && <fieldset className="choice-list"><legend>Unlocked boxes</legend>
      {Object.values(boxes).map(box => <label key={box.id} className="choice-row">
        <input type="checkbox" checked={allowed.includes(box.id)} onChange={event => {
          setAllowed(current => event.target.checked ? [...current, box.id] : current.filter(id => id !== box.id));
        }} />{locationName(boxes, box.id)}
      </label>)}
    </fieldset>}
    <button className="button-primary" disabled={busy}>Save permissions</button>
    <button type="button" onClick={copy}>Copy for agent</button>
  </form>;
}

export function HistoryPanel({ history, currentBranch, viewed, difference, busy, view, compare, onChange, onConnectionChange, rename, fork, live }: {
  history?: History; currentBranch: string; viewed: Version | null;
  difference: (Difference & { before: StorySnapshot; after: StorySnapshot }) | null; busy: boolean;
  view: (version: Version) => void; compare: (fromVersionId: string, toVersionId: string) => void;
  onChange: (id: string, version: Version) => void; rename: (version: Version, name: string) => void;
  onConnectionChange: (connector: Connector, version: Version) => void;
  fork: (version: Version, name: string) => void; live: (branchId?: string) => void;
}) {
  const versions = history?.versions ?? [];
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [branchName, setBranchName] = useState('');
  const [versionName, setVersionName] = useState('');
  const source = from || versions.at(-2)?.id || '';
  const destination = to || versions.at(-1)?.id || '';
  return <div className="form-stack">
    <label className="field">Working branch<select value={currentBranch} onChange={event => live(event.target.value)}>
      {(history?.branches ?? []).map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
    </select></label>
    {viewed && <section className="panel-item form-stack">
      <div className="inline-between"><h3>Viewing {viewed.name}</h3><button type="button" onClick={() => live()}>Back to live</button></div>
      <form className="form-stack" onSubmit={event => { event.preventDefault(); if (versionName.trim()) { rename(viewed, versionName.trim()); setVersionName(''); } }}>
        <label className="field">Version name<input value={versionName} placeholder={viewed.name} maxLength={200} onChange={event => setVersionName(event.target.value)} /></label>
        <button disabled={busy || !versionName.trim()}>Rename version</button>
      </form>
      <form className="form-stack" onSubmit={event => { event.preventDefault(); if (branchName.trim()) { fork(viewed, branchName.trim()); setBranchName(''); } }}>
        <label className="field">New branch name<input value={branchName} maxLength={200} onChange={event => setBranchName(event.target.value)} /></label>
        <button className="button-primary" disabled={busy || !branchName.trim()}>Continue from here</button>
      </form>
    </section>}
    <section className="form-stack" aria-label="Version history">
      <h3>Version graph</h3>
      {history && <VersionGraph history={history} viewed={viewed} onPick={view} />}
    </section>
    <form className="form-stack" onSubmit={event => { event.preventDefault(); if (source && destination) compare(source, destination); }}>
      <h3>Compare versions</h3>
      <label className="field">From version<select value={source} onChange={event => setFrom(event.target.value)}><option value="" disabled>Choose a version</option>{versions.map(version => <option key={version.id} value={version.id}>{version.name}</option>)}</select></label>
      <label className="field">To version<select value={destination} onChange={event => setTo(event.target.value)}><option value="" disabled>Choose a version</option>{versions.map(version => <option key={version.id} value={version.id}>{version.name}</option>)}</select></label>
      <button disabled={busy || !source || !destination || source === destination}>Compare</button>
    </form>
    {difference && <section className="form-stack" aria-label="Version differences">
      <h3>Changes</h3>
      <p className="muted">{difference.from.name} → {difference.to.name}</p>
      {difference.boxes.added.map(box => <Change key={box.id} name={box.title} kind="Added" jump={() => onChange(box.id, difference.to)} />)}
      {difference.boxes.removed.map(box => <Change key={box.id} name={box.title} kind="Removed" jump={() => onChange(box.id, difference.from)} />)}
      {difference.boxes.changed.map(({ after, fields }) => <Change key={after.id} name={after.title} kind={fields.every(field => ['parentId', 'x', 'y'].includes(field)) ? 'Moved' : 'Edited'} jump={() => onChange(after.id, difference.to)} />)}
      {([
        ['Added', difference.connectors.added, difference.after, difference.to],
        ['Removed', difference.connectors.removed, difference.before, difference.from],
        ['Edited', difference.connectors.changed.map(change => change.after), difference.after, difference.to],
      ] as const).map(([kind, links, snapshot, version]) =>
        links.map(link => <div className="panel-item" key={link.id}><span className="badge">{kind} connection</span>
          <button type="button" className="text-link" onClick={() => onConnectionChange(link, version)}>
            {locationName(snapshot.boxes, link.sourceId)} → {link.label} → {locationName(snapshot.boxes, link.targetId)}
          </button>
        </div>),
      )}
      {Object.values(difference.boxes).every(values => !values.length) && Object.values(difference.connectors).every(values => !values.length) && <p className="muted">These versions contain the same canvas.</p>}
    </section>}
  </div>;
}

function VersionGraph({ history, viewed, onPick }: { history: History; viewed: Version | null; onPick: (version: Version) => void }) {
  const graph = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<string[]>([]);
  const laneWidth = Math.min(Math.max(history.branches.length, 1), 5) * 12 + 6;

  useLayoutEffect(() => {
    const root = graph.current!;
    function measure() {
      const origin = root.getBoundingClientRect();
      const points = new Map(Array.from(root.querySelectorAll<HTMLElement>('[data-version-point]'), point => {
        const bounds = point.getBoundingClientRect();
        return [point.dataset.versionPoint, { x: bounds.left + bounds.width / 2 - origin.left, y: bounds.top + bounds.height / 2 - origin.top }];
      }));
      setLines(history.versions.flatMap(version => {
        const parent = version.parentId ? points.get(version.parentId) : undefined;
        const child = points.get(version.id);
        return parent && child ? [`M${parent.x} ${parent.y} V${child.y - 8} L${child.x} ${child.y}`] : [];
      }));
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [history]);

  return <div className="history-lineage" ref={graph} style={{ '--lanes-width': `${laneWidth}px` } as CSSProperties}>
    <svg className="history-branches" width={laneWidth} height="100%" aria-hidden="true">
      {lines.map((line, index) => <path key={index} d={line} />)}
    </svg>
    <ol className="version-graph">
      {history.versions.map(version => {
        const lane = Math.min(4, Math.max(0, history.branches.findIndex(item => item.id === version.branchId)));
        const branch = history.branches[lane];
        const parent = history.versions.find(item => item.id === version.parentId);
        return <li key={version.id} style={{ '--version-lane': `${lane * 12 + 4}px` } as CSSProperties}>
          <i data-version-point={version.id} aria-hidden="true" />
          <button type="button" aria-current={viewed?.id === version.id ? 'true' : undefined} data-version-id={version.id} onClick={() => onPick(version)}>
            <strong>{version.name}</strong><small>{history.branches.find(item => item.id === version.branchId)?.name ?? branch?.name ?? 'branch'} · {version.contributors.join(' and ') || 'created'}</small>
            {parent && <small>From {parent.name}</small>}
          </button>
        </li>;
      })}
    </ol>
  </div>;
}

function Change({ name, kind, jump }: { name: string; kind: string; jump: () => void }) {
  return <div className="panel-item inline-between"><span className="badge">{kind}</span><button type="button" className="text-link" onClick={jump}>{name}</button></div>;
}
