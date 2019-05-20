'use babel';

import { ScrollView } from 'atom-space-pen-views';

const FTP_REMOTE_EDIT_PROTOCOL_URI = 'h3imdall://remote-editor-protocol';
const Queue = require('./../helper/queue.js');

class ProtocolView extends ScrollView {

  static content() {
    return this.div({
      class: 'remote-editor-protocol tool-panel',
    }, () => {
      this.table({
        class: 'remote-editor-protocol-table',
        tabindex: -1,
        outlet: 'table',
      }, () => {
        this.thead({
          outlet: 'head',
        });
        this.tbody({
          outlet: 'list',
        });
      });
    });
  }

  initialize(state) {
    super.initialize(state)
    const self = this;

    atom.workspace.addOpener(uri => {
      if (uri === FTP_REMOTE_EDIT_PROTOCOL_URI) {
        return self;
      }
    });
    atom.workspace.open(FTP_REMOTE_EDIT_PROTOCOL_URI, { activatePane: false, activateItem: false });

    self.head.prepend(`<tr><th>Local file</th><th>Direction</th><th>Remote file</th><th>Size</th><th>Progress</th><th>Status</th></tr>`);

    try {
      Queue.onDidAddFile = (item) => {
        self.list.prepend(item);
        const children = self.list.children();
        if (children.length > 50) {
          children.last().remove();
        }

        item.onError = () => {
          if (atom.config.get('remote-editor.notifications.openProtocolViewOnError')) {
            atom.workspace.open(FTP_REMOTE_EDIT_PROTOCOL_URI);
          }
          // TODO
        };

        item.onTransferring = () => {
          // TODO
        };

        item.onFinished = () => {
          //TODO
        };
      };
    } catch (e) { console.log(e); }
  }

  destroy() {
    const self = this;

    self.remove();
  }

  getTitle() {
    return "Remote Transfer Log";
  }

  getIconName() {
    return "list-unordered";
  }

  getURI() {
    return FTP_REMOTE_EDIT_PROTOCOL_URI;
  }

  getAllowedLocations() {
    return ["bottom"];
  }

  getDefaultLocation() {
    return "bottom";
  }

  toggle() {
    atom.workspace.toggle(this);
  }
}

module.exports = ProtocolView;
