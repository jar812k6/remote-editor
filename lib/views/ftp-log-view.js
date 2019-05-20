'use babel';

import { $, ScrollView } from 'atom-space-pen-views';

class FtpLogView extends ScrollView {

  static content() {
    return this.div({
      class: 'remote-editor-queue tool-panel panel-bottom',
      tabindex: -1,
      outlet: 'queue',
    }, () => {
      this.ul({
        class: 'list',
        tabindex: -1,
        outlet: 'log',
      });
      this.div({
        class: 'remote-editor-resize-handle',
        outlet: 'verticalResize',
      });
    });
  }

  initialize(state) {
    super.initialize(state)

    const self = this;

    // Resize Panel
    self.verticalResize.on('mousedown', (e) => {
      self.resizeVerticalStarted(e);
    });
  }

  destroy() {
    const self = this;

    self.remove();
  }

  addLine(msg) {
    const self = this;

    self.log.prepend(`<li>${msg}</li>`);
    const children = self.log.children();
    if (children.length > 50) {
      children.last().remove();
    }
  }

  resizeVerticalStarted(e) {
    e.preventDefault();

    this.resizeHeightStart = this.height();
    this.resizeMouseStart = e.pageY;
    $(document).on('mousemove', this.resizeVerticalView.bind(this));
    $(document).on('mouseup', this.resizeVerticalStopped);
  }

  resizeVerticalStopped() {
    delete this.resizeHeightStart;
    delete this.resizeMouseStart;
    $(document).off('mousemove', this.resizeVerticalView);
    $(document).off('mouseup', this.resizeVerticalStopped);
  }

  resizeVerticalView(e) {
    if (e.which !== 1) {
      return this.resizeVerticalStopped();
    }

    let delta = e.pageY - this.resizeMouseStart;
    let height = Math.max(26, this.resizeHeightStart - delta);

    this.height(height);
    this.parentView.scroller.css('bottom', `${height}px`);
  }
}

module.exports = FtpLogView;
