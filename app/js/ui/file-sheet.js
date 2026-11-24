// file-sheet.js - a result with no in-app preview (files other than images,
// 3D, audio and video):
// its name; ⋮ has Save… (Google Drive or this phone) and Share (batch 10).
import { h } from './dom.js';
import { Overlay, overlayTop } from './overlay.js';
import { fileMoreButton } from './action-menu.js';

export class FileSheet {
  /** hooks: { onSave(file), onShare(file) } */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.ov = new Overlay('file-sheet', 'Result');
    this.top = overlayTop('', () => this.close(), fileMoreButton(() => this.file, this.hooks));
    this.caption = h('div.ap-caption');
    this.ov.root.append(this.top, h('div.ap-body', {}, h('div.ap-icon', {}, h('i.i.i-folder')), this.caption));
  }

  get root() { return this.ov.root; }
  close() { this.ov.close(); }

  open(file, meta = {}) {
    this.file = file;
    this.top.setTitle(file.filename);
    this.caption.textContent = meta.prompt || '';
    this.ov.show();
  }
}
