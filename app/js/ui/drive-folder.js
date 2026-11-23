// drive-folder.js - "Save to Drive" asks where, every time (batch 8).
// A bottom sheet that browses the folders of My Drive on the PC (server
// /api/drive/folders): a path line you can tap back along, the sub folders,
// "New folder", and "Save here". It opens in the folder last used for that
// kind of file (images, 3D, audio, video), else Comfy UI/<kind folder>.
import { h, toast } from './dom.js';
import * as api from '../api.js';

const LAST = 'driveFolder.v1'; // { image: 'Comfy UI/Images', '3d': 'Projects/Props', ... }
const lastFolders = () => { try { return JSON.parse(localStorage.getItem(LAST)) || {}; } catch { return {}; } };
export function rememberFolder(kind, path) {
  try { localStorage.setItem(LAST, JSON.stringify({ ...lastFolders(), [kind]: path })); } catch {}
}
export const lastFolder = (kind) => lastFolders()[kind];

export class DriveFolderSheet {
  /** Resolves with the chosen folder ("Comfy UI/Images", '' = My Drive) or null when cancelled. */
  choose(kind = 'image') {
    this.close();
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.scrim = h('div.sheet-scrim', { onclick: () => this.finish(null) });
      this.list = h('div.df-list');
      this.crumbs = h('div.df-crumbs');
      this.saveBtn = h('button.btn.primary', { type: 'button', dataset: { act: 'save-here' }, onclick: () => this.finish(this.path) }, h('i.i.i-cloud-upload'), 'Save here');
      this.el = h('div.sheet.drive-sheet', { role: 'dialog', 'aria-label': 'Save to Drive' },
        h('div.sheet-title', {}, 'Save to Drive'), this.crumbs, this.list,
        h('div.sp-actions', {}, h('button.btn', { type: 'button', dataset: { act: 'cancel' }, onclick: () => this.finish(null) }, 'Cancel'), this.saveBtn));
      document.body.append(this.scrim, this.el);
      this.keydown = (e) => { if (e.key === 'Escape') this.finish(null); };
      document.addEventListener('keydown', this.keydown);
      this.load(lastFolder(kind), kind);
    });
  }

  async load(path, kind) {
    this.list.replaceChildren(h('div.muted.df-msg', {}, 'Loading…'));
    let r;
    // Drive not there (Drive for desktop not running ...): say so and close.
    try { r = await api.getDriveFolders(path ?? ''); } catch (e) { toast(e.message, 8000); this.finish(null); return; }
    // First time for this kind: start in its default folder (Comfy UI/Images ...).
    if (path === undefined && kind && r.defaults?.[kind]) return this.load(r.defaults[kind]);
    this.root = r.root; this.path = r.path; this.saveBtn.disabled = false;
    const parts = r.path ? r.path.split('/') : [];
    const crumb = (label, to, last) => h(`button.df-crumb${last ? '.on' : ''}`, { type: 'button', onclick: () => !last && this.load(to) }, label);
    this.crumbs.replaceChildren(crumb(r.root || 'My Drive', '', !parts.length),
      ...parts.flatMap((p, i) => [h('span.df-sep', {}, '›'), crumb(p, parts.slice(0, i + 1).join('/'), i === parts.length - 1)]));
    const rows = r.folders.map((name) => h('button.sheet-row', { type: 'button', dataset: { folder: name }, onclick: () => this.load(r.path ? `${r.path}/${name}` : name) },
      h('i.i.i-folder'), h('span.nm', {}, name), h('i.i.i-chevron-right')));
    this.list.replaceChildren(...rows, this.newRow());
    this.crumbs.lastElementChild?.scrollIntoView?.({ inline: 'end', block: 'nearest' });
  }

  newRow() {
    const row = h('button.sheet-row.df-new', { type: 'button', dataset: { act: 'new-folder' }, onclick: () => {
      const input = h('input.sheet-input', { type: 'text', placeholder: 'Folder name', maxlength: 120, 'aria-label': 'New folder name' });
      const make = async () => {
        const name = input.value.trim(); if (!name) return;
        try { const r = await api.makeDriveFolder(this.path, name); this.load(r.path); } catch (e) { toast(e.message, 6000); }
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') make(); });
      row.replaceWith(h('div.sheet-new', {}, h('i.i.i-plus'), input, h('button.btn', { type: 'button', dataset: { act: 'create' }, onclick: make }, 'Create')));
      setTimeout(() => input.focus(), 0);
    } }, h('i.i.i-plus'), h('span.nm', {}, 'New folder'), h('span'));
    return row;
  }

  finish(v) {
    const r = this.resolve; this.resolve = null;
    this.close();
    r?.(v);
  }

  close() {
    this.scrim?.remove(); this.el?.remove(); this.scrim = this.el = null;
    if (this.keydown) document.removeEventListener('keydown', this.keydown);
    if (this.resolve) { const r = this.resolve; this.resolve = null; r(null); }
  }
}
