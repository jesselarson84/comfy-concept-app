// file-sheet.js - a result with no in-app preview (files other than images,
// 3D, audio and video):
// its name plus Download and Save to Drive.
import { h } from './dom.js';
import { Overlay, overlayTop } from './overlay.js';

export class FileSheet {
  /** hooks: { onDownload(file), onSaveToDrive(file) } */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.ov = new Overlay('file-sheet', 'Result');
    this.top = overlayTop('', () => this.close());
    this.caption = h('div.ap-caption');
    this.ov.root.append(this.top, h('div.ap-body', {}, h('div.ap-icon', {}, h('i.i.i-folder')), this.caption,
      h('div.ov-actions', {},
        h('button.btn', { type: 'button', dataset: { act: 'download' }, onclick: () => this.file && this.hooks.onDownload?.(this.file) }, h('i.i.i-download'), 'Download'),
        h('button.btn', { type: 'button', dataset: { act: 'drive' }, onclick: () => this.file && this.hooks.onSaveToDrive?.(this.file) }, h('i.i.i-cloud-upload'), 'Save to Drive'))));
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
