import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import { boxSizeLimits, boxTypes, connectorPresets, getBoxSize, type Box, type StorySnapshot } from '../shared/story.js';

export const titleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export function boxPath(boxes: StorySnapshot['boxes'], id: string) {
  const path: Box[] = [];
  let box: Box | undefined = boxes[id];
  while (box) {
    path.unshift(box);
    box = box.parentId ? boxes[box.parentId] : undefined;
  }
  return path;
}

export function locationName(boxes: StorySnapshot['boxes'], id: string) {
  return boxPath(boxes, id).map(box => box.title).join(' › ') || 'Deleted box';
}

export function Dialog({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const opener = document.activeElement;
    element.showModal();
    element.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
    return () => {
      element.close();
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);
  return <dialog className="dialog" ref={dialog} aria-label={title} onCancel={event => { event.preventDefault(); close(); }}>
    <header className="panel-header"><h2>{title}</h2><button type="button" className="button-quiet" aria-label="Close dialog" onClick={close}>×</button></header>
    <div className="panel-body">{children}</div>
  </dialog>;
}

export function BoxPicker({ boxes, value, onPick, excluded = [], root = false }: {
  boxes: StorySnapshot['boxes']; value: string | null; onPick: (id: string | null) => void; excluded?: string[]; root?: boolean;
}) {
  const [expanded, setExpanded] = useState<string[]>(value ? boxPath(boxes, value).map(box => box.id) : []);
  function children(parentId: string | null): ReactNode {
    const items = Object.values(boxes).filter(box => box.parentId === parentId && !excluded.includes(box.id));
    if (items.length === 0) return null;
    return <ul className="box-picker-tree">{items.map(box => {
      const hasChildren = Object.values(boxes).some(item => item.parentId === box.id && !excluded.includes(item.id));
      const open = expanded.includes(box.id);
      return <li key={box.id}>
        <div className="picker-row">
          {hasChildren && <button type="button" className="button-quiet" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${box.title}`} onClick={() => setExpanded(current => open ? current.filter(id => id !== box.id) : [...current, box.id])}>{open ? '−' : '+'}</button>}
          <button className="picker-box" type="button" aria-pressed={value === box.id} onClick={() => onPick(box.id)}>{box.title}<small>{titleCase(box.type)}</small></button>
        </div>
        {open && children(box.id)}
      </li>;
    })}</ul>;
  }
  return <div className="box-picker" aria-label="Choose a box">
    {root && <button type="button" aria-pressed={value === null} onClick={() => onPick(null)}>Main canvas</button>}
    {children(null)}
  </div>;
}

export function BoxForm({ box, onSave, submitLabel, busy }: {
  box?: Pick<Box, 'title' | 'type' | 'body'>; onSave: (fields: Pick<Box, 'title' | 'type' | 'body'>) => void | Promise<void>; submitLabel: string; busy: boolean;
}) {
  const [title, setTitle] = useState(box?.title ?? '');
  const [type, setType] = useState<Box['type']>(box?.type ?? 'event');
  const [body, setBody] = useState(box?.body ?? '');
  function submit(event: FormEvent) { event.preventDefault(); if (title.trim()) void onSave({ title: title.trim(), type, body }); }
  return <form className="form-stack" onSubmit={submit}>
    <label className="field">Title<input name="title" data-initial-focus required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></label>
    <label className="field">Type<select value={type} onChange={event => setType(event.target.value as Box['type'])}>{boxTypes.map(value => <option key={value} value={value}>{titleCase(value)}</option>)}</select></label>
    <label className="field">Text<textarea name="body" value={body} onChange={event => setBody(event.target.value)} rows={5} /></label>
    <button className="button-primary" disabled={busy || !title.trim()}>{submitLabel}</button>
  </form>;
}

export function BoxSizeForm({ box, revisionId, busy, save }: {
  box: Box; revisionId: string; busy: boolean;
  save: (size: ReturnType<typeof getBoxSize>, revisionId: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<{ width: string; minHeight: string; revisionId: string | null }>();
  const [saveFailed, setSaveFailed] = useState(false);
  const current = getBoxSize(box);
  const shown = draft ?? { width: String(current.width), minHeight: String(current.minHeight), revisionId: null };
  const submitted = { width: Number(shown.width), minHeight: Number(shown.minHeight) };
  const unchanged = submitted.width === current.width && submitted.minHeight === current.minHeight;
  function change(field: 'width' | 'minHeight', value: string) {
    setDraft({ ...shown, [field]: value, revisionId: shown.revisionId ?? revisionId });
  }
  return <form className="box-size-form form-stack" onSubmit={event => {
    event.preventDefault();
    if (unchanged || busy) return;
    void save(submitted, shown.revisionId ?? revisionId).then(saved => {
      setSaveFailed(!saved);
      if (saved) setDraft(latest => latest === draft ? undefined : latest);
    });
  }}>
    <div className="box-size-fields">
      <label className="field">Width<input
        data-box-size-width
        type="number" required step="any" min={boxSizeLimits.minWidth} max={boxSizeLimits.maxWidth} disabled={busy}
        value={shown.width} onChange={event => change('width', event.target.value)}
      /></label>
      <label className="field">Minimum height<input
        type="number" required step="any" min={boxSizeLimits.minHeight} max={boxSizeLimits.maxHeight} disabled={busy}
        value={shown.minHeight} onChange={event => change('minHeight', event.target.value)}
      /></label>
    </div>
    <button type="submit" disabled={busy || unchanged}>Apply size</button>
    {saveFailed && draft && <button type="button" disabled={busy} onClick={() => { setDraft(undefined); setSaveFailed(false); }}>Load current size</button>}
  </form>;
}

export function ConnectorForm({ boxes, source, initialTargetId, busy, onSave }: {
  boxes: StorySnapshot['boxes']; source: Box; initialTargetId?: string; busy: boolean;
  onSave: (targetId: string, label: string, reverseLabel: string | null) => void;
}) {
  const [target, setTarget] = useState<string | null>(initialTargetId ?? null);
  const [label, setLabel] = useState('supports');
  return <form className="form-stack" onSubmit={event => {
    event.preventDefault();
    if (target && label.trim()) onSave(target, label.trim(), connectorPresets.find(item => item.label === label.trim())?.reverseLabel ?? null);
  }}>
    <p className="muted">From <strong>{locationName(boxes, source.id)}</strong></p>
    <BoxPicker boxes={boxes} value={target} onPick={setTarget} />
    <label className="field">Relationship<input data-initial-focus={initialTargetId ? '' : undefined} list="relationship-labels" value={label} onChange={event => setLabel(event.target.value)} required maxLength={100} /></label>
    <datalist id="relationship-labels">{connectorPresets.map(value => <option key={value.label} value={value.label} />)}</datalist>
    {target && <p className="muted">{source.title} → {label} → {locationName(boxes, target)}</p>}
    <button className="button-primary" disabled={!target || target === source.id || !label.trim() || busy}>Connect</button>
  </form>;
}

export function WrittenText({ body, jump }: { body: string; jump: (id: string) => void }) {
  return <div className="written-text">
    <Markdown urlTransform={url => url.startsWith('story:') ? url : defaultUrlTransform(url)} components={{
      a: ({ href, children }) => href?.startsWith('story:')
        ? <button className="text-link" type="button" onClick={() => jump(href.slice('story:'.length))}>{children}</button>
        : <a href={href} rel="noreferrer">{children}</a>,
    }}>{body}</Markdown>
  </div>;
}
