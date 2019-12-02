'use babel';

import { CompositeDisposable, Disposable } from 'atom';
import { decrypt, encrypt, checkPasswordExists, checkPassword, changePassword, isInWhiteList, isInBlackList, addToWhiteList, addToBlackList } from './helper/secure.js';
import { basename, dirname, trailingslashit, normalize } from './helper/format.js';
import { logDebug, showMessage, getFullExtension, createLocalPath, deleteLocalPath, moveLocalPath, getTextEditor, permissionsToRights } from './helper/helper.js';

let ConfigurationView = null;
let PermissionsView = null;
let TreeView = null;
let ProtocolView = null;
let FinderView = null;

let ChangePassDialog = null;
let PromptPassDialog = null;
let AddDialog = null;
let RenameDialog = null;
let FindDialog = null;
let DuplicateDialog = null;

let Electron = null;
let Path = null;
let FileSystem = null;
let Queue = null;
let Storage = null;

const atom = global.atom;
const getIconServices = require('./helper/icon.js');
const config = require('./config/config-schema.json');
const server_config = require('./config/server-schema.json');

class FtpRemoteEdit {

  constructor() {
    const self = this;

    self.info = [];
    self.config = config;
    self.subscriptions = null;

    self.treeView = null;
    self.protocolView = null;
    self.configurationView = null;
    self.finderView = null;
    self.loaded = false;
  }

  activate() {
    const self = this;

    // Events subscribed to in atom's system can be easily cleaned up with a CompositeDisposable
    self.subscriptions = new CompositeDisposable();

    // Register command that toggles this view
    self.subscriptions.add(atom.commands.add('atom-workspace', {
      'remote-editor:toggle': () => self.toggle(),
      'remote-editor:toggle-focus': () => self.toggleFocus(),
      'remote-editor:show': () => self.show(),
      'remote-editor:hide': () => self.hide(),
      'remote-editor:unfocus': () => self.unfocus(),
      'remote-editor:edit-servers': () => self.configuration(),
      'remote-editor:change-password': () => self.changePassword(),
      'remote-editor:open-file': () => self.open(),
      'remote-editor:open-file-pending': () => self.open(true),
      'remote-editor:new-file': () => self.create('file'),
      'remote-editor:new-directory': () => self.create('directory'),
      'remote-editor:duplicate': () => self.duplicate(),
      'remote-editor:delete': () => self.delete(),
      'remote-editor:rename': () => self.rename(),
      'remote-editor:copy': () => self.copy(),
      'remote-editor:cut': () => self.cut(),
      'remote-editor:paste': () => self.paste(),
      'remote-editor:chmod': () => self.chmod(),
      'remote-editor:upload-file': () => self.upload('file'),
      'remote-editor:upload-directory': () => self.upload('directory'),
      'remote-editor:download': () => self.download(),
      'remote-editor:reload': () => self.reload(),
      'remote-editor:find-remote-path': () => self.findRemotePath(),
      'remote-editor:copy-remote-path': () => self.copyRemotePath(),
      'remote-editor:finder': () => self.remotePathFinder(),
      'remote-editor:finder-reindex-cache': () => self.remotePathFinder(true),
      'remote-editor:add-temp-server': () => self.addTempServer(),
      'remote-editor:remove-temp-server': () => self.removeTempServer(),
    }));

    // Events
    atom.packages.onDidActivatePackage((activatePackage) => {
      if (activatePackage.name == 'remote-editor') {
        if (atom.config.get('remote-editor.tree.toggleOnStartup')) {
          self.toggle();
        }
      }
    });
  }

  init() {
    const self = this;

    if (!self.loaded) {
      self.loaded = true;

      require('events').EventEmitter.defaultMaxListeners = 0;

      ConfigurationView = require('./views/configuration-view');
      PermissionsView = require('./views/permissions-view');
      TreeView = require('./views/tree-view');
      ProtocolView = require('./views/protocol-view');
      FinderView = require('./views/finder-view');

      ChangePassDialog = require('./dialogs/change-pass-dialog');
      PromptPassDialog = require('./dialogs/prompt-pass-dialog');
      AddDialog = require('./dialogs/add-dialog');
      RenameDialog = require('./dialogs/rename-dialog');
      FindDialog = require('./dialogs/find-dialog');
      DuplicateDialog = require('./dialogs/duplicate-dialog');

      Electron = require('electron');
      Path = require('path');
      FileSystem = require('fs-plus');
      Queue = require('./helper/queue.js');
      Storage = require('./helper/storage.js');

      // Events
      // Config change
      atom.config.onDidChange('remote-editor.config', () => {
        if (Storage.getPassword()) {
          Storage.load(true);
          self.getTreeViewInstance().reload();
        }
      });

      // Drag & Drop
      self.getTreeViewInstance().on('drop', (e) => {
        self.drop(e);
      });

      // Auto Reveal Active File
      atom.workspace.getCenter().onDidStopChangingActivePaneItem((item) => {
        self.autoRevealActiveFile();
      });

      // Workaround to activate core.allowPendingPaneItems if remote-editor.tree.allowPendingPaneItems is activated
      atom.config.onDidChange('remote-editor.tree.allowPendingPaneItems', ({ newValue, oldValue }) => {
        if (newValue == true && !atom.config.get('core.allowPendingPaneItems')) {
          atom.config.set('core.allowPendingPaneItems', true)
        }
      });
      if (atom.config.get('remote-editor.tree.allowPendingPaneItems')) {
        atom.config.set('core.allowPendingPaneItems', true)
      }

      // Init protocoll view
      self.getProtocolViewInstance();
    }
  }

  deactivate() {
    const self = this;

    if (self.subscriptions) {
      self.subscriptions.dispose();
      self.subscriptions = null;
    }

    if (self.treeView) {
      self.treeView.destroy();
    }

    if (self.protocolView) {
      self.protocolView.destroy();
    }

    if (self.configurationView) {
      self.configurationView.destroy();
    }

    if (self.finderView) {
      finderView.destroy();
    }
  }

  serialize() {
    return {};
  }

  handleURI(parsedUri) {
    const self = this;

    let regex = /(\/)?([a-z0-9_\-]{1,5}:\/\/)(([^:]{1,})((:(.{1,}))?[\@\x40]))?([a-z0-9_\-.]+)(:([0-9]*))?(.*)/gi;
    let is_matched = parsedUri.path.match(regex);

    if (is_matched) {

      if (!self.getTreeViewInstance().isVisible()) {
        self.toggle();
      }

      let matched = regex.exec(parsedUri.path);

      let protocol = matched[2];
      let username = (matched[4] !== undefined) ? decodeURIComponent(matched[4]) : '';
      let password = (matched[7] !== undefined) ? decodeURIComponent(matched[7]) : '';
      let host = (matched[8] !== undefined) ? matched[8] : '';
      let port = (matched[10] !== undefined) ? matched[10] : '';
      let path = (matched[11] !== undefined) ? decodeURIComponent(matched[11]) : "/";

      let newconfig = JSON.parse(JSON.stringify(server_config));
      newconfig.name = (username) ? protocol + username + '@' + host : protocol + host;
      newconfig.host = host;
      newconfig.port = (port) ? port : ((protocol == 'sftp://') ? '22' : '21');
      newconfig.user = username;
      newconfig.password = password;
      newconfig.sftp = (protocol == 'sftp://');
      newconfig.remote = path;
      newconfig.temp = true;

      logDebug("Adding new server by uri handler", newconfig);

      self.getTreeViewInstance().addServer(newconfig);
    }
  }

  openRemoteFile() {
    const self = this;

    return (file) => {
      const selected = self.getTreeViewInstance().list.find('.selected');

      if (selected.length === 0) return;

      let root = selected.view().getRoot();
      let localPath = normalize(root.getLocalPath());
      localPath = normalize(Path.join(localPath.slice(0, localPath.lastIndexOf(root.getPath())), file).replace(/\/+/g, Path.sep), Path.sep);

      try {
        let file = self.getTreeViewInstance().getElementByLocalPath(localPath, root, 'file');
        self.openFile(file);

        return true;
      } catch (ex) {
        logDebug(ex)

        return false;
      }
    }
  }

  getCurrentServerName() {
    const self = this;

    return () => {
      return new Promise((resolve, reject) => {
        const selected = self.getTreeViewInstance().list.find('.selected');
        if (selected.length === 0) reject('noservers');

        let root = selected.view().getRoot();
        resolve(root.name);
      })
    }
  }

  getCurrentServerConfig() {
    const self = this;

    return (reasonForRequest) => {
      return new Promise((resolve, reject) => {
        if (!reasonForRequest) {
          reject('noreasongiven');
          return;
        }

        const selected = self.getTreeViewInstance().list.find('.selected');
        if (selected.length === 0) {
          reject('noservers');
          return;
        }

        if (!Storage.hasPassword()) {
          reject('nopassword');
          return;
        }

        let root = selected.view().getRoot();
        let buttondismiss = false;

        if (isInBlackList(Storage.getPassword(), reasonForRequest)) {
          reject('userdeclined');
          return;
        }
        if (isInWhiteList(Storage.getPassword(), reasonForRequest)) {
          resolve(root.config);
          return;
        }

        let caution = 'Decline this message if you did not initiate a request to share your server configuration with a pacakge!'
        let notif = atom.notifications.addWarning('Server Configuration Requested', {
          detail: reasonForRequest + '\n-------------------------------\n' + caution,
          dismissable: true,
          buttons: [{
            text: 'Always',
            onDidClick: () => {
              buttondismiss = true;
              notif.dismiss();
              addToWhiteList(Storage.getPassword(), reasonForRequest);
              resolve(root.config);
            }
          },
          {
            text: 'Accept',
            onDidClick: () => {
              buttondismiss = true;
              notif.dismiss();
              resolve(root.config);
            }
          },
          {
            text: 'Decline',
            onDidClick: () => {
              buttondismiss = true;
              notif.dismiss();
              reject('userdeclined');
            }
          },
          {
            text: 'Never',
            onDidClick: () => {
              buttondismiss = true;
              notif.dismiss();
              addToBlackList(Storage.getPassword(), reasonForRequest);
              reject('userdeclined');
            }
          },
          ]
        });

        let disposable = notif.onDidDismiss(() => {
          if (!buttondismiss) reject('userdeclined');
          disposable.dispose();
        })
      })
    }
  }

  consumeElementIcons(service) {
    getIconServices().setElementIcons(service);

    return new Disposable(() => {
      getIconServices().resetElementIcons();
    })
  }

  promtPassword() {
    const self = this;
    const dialog = new PromptPassDialog();

    let promise = new Promise((resolve, reject) => {
      dialog.on('dialog-done', (e, password) => {
        if (checkPassword(password)) {
          Storage.setPassword(password);
          dialog.close();

          resolve(true);
        } else {
          dialog.showError('Wrong password, try again!');
        }
      });

      dialog.attach();
    });

    return promise;
  }

  changePassword(mode) {
    const self = this;

    const options = {};
    if (mode == 'add') {
      options.mode = 'add';
      options.prompt = 'Enter the master password. All information about your server settings will be encrypted with this password.';
    } else {
      options.mode = 'change';
    }

    const dialog = new ChangePassDialog(options);
    let promise = new Promise((resolve, reject) => {
      dialog.on('dialog-done', (e, passwords) => {

        // Check that password from new master password can decrypt current config
        if (mode == 'add') {
          let configHash = atom.config.get('remote-editor.config');
          if (configHash) {
            let newPassword = passwords.newPassword;
            let testConfig = decrypt(newPassword, configHash);

            try {
              let testJson = JSON.parse(testConfig);
            } catch (e) {
              // If master password does not decrypt current config,
              // prompt the user to reply to insert correct password
              // or reset config content
              showMessage('Master password does not match with previous used. Please retry or delete "config" entry in remote-editor configuration node.', 'error');

              dialog.close();
              resolve(false);
              return;
            }
          }
        }

        let oldPasswordValue = (mode == 'add') ? passwords.newPassword : passwords.oldPassword;

        changePassword(oldPasswordValue, passwords.newPassword).then(() => {
          Storage.setPassword(passwords.newPassword);

          if (mode != 'add') {
            showMessage('Master password successfully changed. Please restart atom!', 'success');
          }
          resolve(true);
        });

        dialog.close();
      });

      dialog.attach();
    });

    return promise;
  }

  toggle() {
    const self = this;

    self.init();

    if (!Storage.hasPassword()) {
      if (!checkPasswordExists()) {
        self.changePassword('add').then((returnValue) => {
          if (returnValue) {
            if (Storage.load()) {
              self.getTreeViewInstance().reload();
              self.getTreeViewInstance().toggle();
            }
          }
        });
        return;
      } else {
        self.promtPassword().then(() => {
          if (Storage.load()) {
            self.getTreeViewInstance().reload();
            self.getTreeViewInstance().toggle();
          }
        });
        return;
      }
    } else if (!Storage.loaded && Storage.load()) {
      self.getTreeViewInstance().reload();
    }
    self.getTreeViewInstance().toggle();
  }

  toggleFocus() {
    const self = this;

    if (!Storage.hasPassword()) {
      self.toggle();
    } else {
      self.getTreeViewInstance().toggleFocus();
    }
  }

  unfocus() {
    const self = this;

    self.getTreeViewInstance().unfocus();
  }

  show() {
    const self = this;

    if (!Storage.hasPassword()) {
      self.toggle();
    } else {
      self.getTreeViewInstance().show();
    }
  }

  hide() {
    const self = this;

    self.getTreeViewInstance().hide();
  }

  configuration() {
    const self = this;
    const selected = self.getTreeViewInstance().list.find('.selected');

    let root = null;
    if (selected.length !== 0) {
      root = selected.view().getRoot();
    };

    if (!Storage.hasPassword()) {
      self.promtPassword().then(() => {
        if (Storage.load()) {
          self.getConfigurationViewInstance().reload(root);
          self.getConfigurationViewInstance().attach();
        }
      });
      return;
    }

    self.getConfigurationViewInstance().reload(root);
    self.getConfigurationViewInstance().attach();
  }

  addTempServer() {
    const self = this;
    const selected = self.getTreeViewInstance().list.find('.selected');

    let root = null;
    if (selected.length !== 0) {
      root = selected.view().getRoot();
      root.config.temp = false;
      self.getTreeViewInstance().removeServer(selected.view());
      Storage.addServer(root.config);
      Storage.save();
    };
  }

  removeTempServer() {
    const self = this;
    const selected = self.getTreeViewInstance().list.find('.selected');

    if (selected.length !== 0) {
      self.getTreeViewInstance().removeServer(selected.view());
    };
  }

  open(pending = false) {
    const self = this;
    const selected = self.getTreeViewInstance().list.find('.selected');

    if (selected.length === 0) return;

    if (selected.view().is('.file')) {
      let file = selected.view();
      if (file) {
        self.openFile(file, pending);
      }
    } else if (selected.view().is('.directory')) {
      let directory = selected.view();
      if (directory) {
        self.openDirectory(directory);
      }
    }
  }

  openFile(file, pending = false) {
    const self = this;

    const fullRelativePath = normalize(file.getPath(true) + file.name);
    const fullLocalPath = normalize(file.getLocalPath(true) + file.name, Path.sep);

    // Check if file is already opened in texteditor
    if (getTextEditor(fullLocalPath, true)) {
      atom.workspace.open(fullLocalPath, { pending: pending, searchAllPanes: true })
      return false;
    }

    self.downloadFile(file.getRoot(), fullRelativePath, fullLocalPath, { filesize: file.size }).then(() => {
      // Open file and add handler to editor to upload file on save
      return self.openFileInEditor(file, pending);
    }).catch((err) => {
      showMessage(err, 'error');
    });
  }

  openDirectory(directory) {
    const self = this;

    directory.expand();
  }

  create(type) {
    const self = this;
    const selected = self.getTreeViewInstance().list.find('.selected');

    if (selected.length === 0) return;

    if (selected.view().is('.file')) {
      directory = selected.view().parent;
    } else {
      directory = selected.view();
    }

    if (directory) {
      if (type == 'file') {
        const dialog = new AddDialog(directory.getPath(false), true);
        dialog.on('new-path', (e, relativePath) => {
          if (relativePath) {
            self.createFile(directory, relativePath);
            dialog.close();
          }
        });
        dialog.attach();
      } else if (type == 'directory') {
        const dialog = new AddDialog(directory.getPath(false), false);
        dialog.on('new-path', (e, relativePath) => {
          if (relativePath) {
            self.createDirectory(directory, relativePath);
            dialog.close();
          }
        });
        dialog.attach();
      }
    }
  }

  createFile(directory, relativePath) {
    const self = this;

    const fullRelativePath = normalize(directory.getRoot().getPath(true) + relativePath);
    const fullLocalPath = normalize(directory.getRoot().getLocalPath(true) + relativePath, Path.sep);

    try {
      // create local file
      if (!FileSystem.existsSync(fullLocalPath)) {
        // Create local Directory
        createLocalPath(fullLocalPath);
        FileSystem.writeFileSync(fullLocalPath, '');
      }
    } catch (err) {
      showMessage(err, 'error');
      return false;
    }

    directory.getConnector().existsFile(fullRelativePath).then(() => {
      showMessage('File ' + relativePath.trim() + ' already exists', 'error');
    }).catch(() => {
      self.uploadFile(directory, fullLocalPath, fullRelativePath, false).then((duplicatedFile) => {
        if (duplicatedFile) {
          // Open file and add handler to editor to upload file on save
          return self.openFileInEditor(duplicatedFile);
        }
      }).catch((err) => {
        showMessage(err, 'error');
      });
    });
  }

  createDirectory(directory, relativePath) {
    const self = this;

    relativePath = trailingslashit(relativePath);
    const fullRelativePath = normalize(directory.getRoot().getPath(true) + relativePath);
    const fullLocalPath = normalize(directory.getRoot().getLocalPath(true) + relativePath, Path.sep);

    // create local directory
    try {
      if (!FileSystem.existsSync(fullLocalPath)) {
        createLocalPath(fullLocalPath);
      }
    } catch (err) { }

    directory.getConnector().existsDirectory(fullRelativePath).then((result) => {
      showMessage('Directory ' + relativePath.trim() + ' already exists', 'error');
    }).catch((err) => {
      return directory.getConnector().createDirectory(fullRelativePath).then((result) => {
        // Add to tree
        let element = self.getTreeViewInstance().addDirectory(directory.getRoot(), relativePath);
        if (element.isVisible()) {
          element.select();
        }
      }).catch((err) => {
        showMessage(err.message, 'error');
      });
    });
  }

  rename() {
    const self = this;
    const selected = self.getTreeViewInstance().list.find('.selected');

    if (selected.length === 0) return;

    if (selected.view().is('.file')) {
      let file = selected.view();
      if (file) {
        const dialog = new RenameDialog(file.getPath(false) + file.name, true);
        dialog.on('new-path', (e, relativePath) => {
          if (relativePath) {
            self.renameFile(file, relativePath);
            dialog.close();
          }
        });
        dialog.attach();
      }
    } else if (selected.view().is('.directory')) {
      let directory = selected.view();
      if (directory) {
        const dialog = new RenameDialog(trailingslashit(directory.getPath(false)), false);
        dialog.on('new-path', (e, relativePath) => {
          if (relativePath) {
            self.renameDirectory(directory, relativePath);
            dialog.close();
          }
        });
        dialog.attach();
      }
    }
  }

  renameFile(file, relativePath) {
    const self = this;

    const fullRelativePath = normalize(file.getRoot().getPath(true) + relativePath);
    const fullLocalPath = normalize(file.getRoot().getLocalPath(true) + relativePath, Path.sep);

    file.getConnector().rename(file.getPath(true) + file.name, fullRelativePath).then(() => {
      // Refresh cache
      file.getRoot().getFinderCache().renameFile(normalize(file.getPath(false) + file.name), normalize(relativePath), file.size);

      // Add to tree
      let element = self.getTreeViewInstance().addFile(file.getRoot(), relativePath, { size: file.size, rights: file.rights });
      if (element.isVisible()) {
        element.select();
      }

      // Check if file is already opened in texteditor
      let found = getTextEditor(file.getLocalPath(true) + file.name);
      if (found) {
        element.addClass('open');
        found.saveObject = element;
        found.saveAs(element.getLocalPath(true) + element.name);
      }

      // Move local file
      moveLocalPath(file.getLocalPath(true) + file.name, fullLocalPath);

      // Remove old file from tree
      if (file) file.remove()
    }).catch((err) => {
      showMessage(err.message, 'error');
    });
  }

  renameDirectory(directory, relativePath) {
    const self = this;

    relativePath = trailingslashit(relativePath);
    const fullRelativePath = normalize(directory.getRoot().getPath(true) + relativePath);
    const fullLocalPath = normalize(directory.getRoot().getLocalPath(true) + relativePath, Path.sep);

    directory.getConnector().rename(directory.getPath(), fullRelativePath).then(() => {
      // Refresh cache
      directory.getRoot().getFinderCache().renameDirectory(normalize(directory.getPath(false)), normalize(relativePath + '/'));

      // Add to tree
      let element = self.getTreeViewInstance().addDirectory(directory.getRoot(), relativePath, { rights: directory.rights });
      if (element.isVisible()) {
        element.select();
      }

      // TODO
      // Check if files are already opened in texteditor

      // Move local directory
      moveLocalPath(directory.getLocalPath(true), fullLocalPath);

      // Remove old directory from tree
      if (directory) directory.remove()
    }).catch((err) => {
      showMessage(err.message, 'error');
    });
  }

  duplicate() {
    const self = this;
    const selected = self.getTreeViewInstance().list.find('.selected');

    if (selected.length === 0) return;

    if (selected.view().is('.file')) {
      let file = selected.view();
      if (file) {
        const dialog = new DuplicateDialog(file.getPath(false) + file.name);
        dialog.on('new-path', (e, relativePath) => {
          if (relativePath) {
            self.duplicateFile(file, relativePath);
            dialog.close();
          }
        });
        dialog.attach();
      }
    } else if (selected.view().is('.directory')) {
      // TODO
      // let directory = selected.view();
      // if (directory) {
      //   const dialog = new DuplicateDialog(trailingslashit(directory.getPath(false)));
      //   dialog.on('new-path', (e, relativePath) => {
      //     if (relativePath) {
      //       self.duplicateDirectory(directory, relativePath);
      //       dialog.close();
      //     }
      //   });
      //   dialog.attach();
      // }
    }
  }

  duplicateFile(file, relativePath) {
    const self = this;

    const fullRelativePath = normalize(file.getRoot().getPath(true) + relativePath);
    const fullLocalPath = normalize(file.getRoot().getLocalPath(true) + relativePath, Path.sep);

    file.getConnector().existsFile(fullRelativePath).then(() => {
      showMessage('File ' + relativePath.trim() + ' already exists', 'error');
    }).catch(() => {
      self.downloadFile(file.getRoot(), file.getPath(true) + file.name, fullLocalPath, { filesize: file.size }).then(() => {
        self.uploadFile(file.getRoot(), fullLocalPath, fullRelativePath).then((duplicatedFile) => {
          if (duplicatedFile) {
            // Open file and add handler to editor to upload file on save
            return self.openFileInEditor(duplicatedFile);
          }
        }).catch((err) => {
          showMessage(err, 'error');
        });
      }).catch((err) => {
        showMessage(err, 'error');
      });
    });
  }

  duplicateDirectory(directory, relativePath) {
    const self = this;

    const fullRelativePath = normalize(directory.getRoot().getPath(true) + relativePath);
    const fullLocalPath = normalize(directory.getRoot().getLocalPath(true) + relativePath, Path.sep);

    // TODO
  }

  delete() {
    const self = this;
    const selected = self.getTreeViewInstance().list.find('.selected');

    if (selected.length === 0) return;

    if (selected.view().is('.file')) {
      let file = selected.view();
      if (file) {
        atom.confirm({
          message: 'Are you sure you want to delete this file?',
          detailedMessage: "You are deleting:\n" + file.getPath(false) + file.name,
          buttons: {
            Yes: () => {
              self.deleteFile(file);
            },
            Cancel: () => {
              return true;
            }
          }
        });
      }
    } else if (selected.view().is('.directory')) {
      let directory = selected.view();
      if (directory) {
        atom.confirm({
          message: 'Are you sure you want to delete this folder?',
          detailedMessage: "You are deleting:\n" + trailingslashit(directory.getPath(false)),
          buttons: {
            Yes: () => {
              self.deleteDirectory(directory, true);
            },
            Cancel: () => {
              return true;
            }
          }
        });
      }
    }
  }

  deleteFile(file) {
    const self = this;

    const fullLocalPath = normalize(file.getLocalPath(true) + file.name, Path.sep);

    file.getConnector().deleteFile(file.getPath(true) + file.name).then(() => {
      // Refresh cache
      file.getRoot().getFinderCache().deleteFile(normalize(file.getPath(false) + file.name));

      // Delete local file
      try {
        if (FileSystem.existsSync(fullLocalPath)) {
          FileSystem.unlinkSync(fullLocalPath);
        }
      } catch (err) { }

      file.parent.select();
      file.destroy();
    }).catch((err) => {
      showMessage(err.message, 'error');
    });
  }

  deleteDirectory(directory, recursive) {
    const self = this;

    directory.getConnector().deleteDirectory(directory.getPath(), recursive).then(() => {
      // Refresh cache
      directory.getRoot().getFinderCache().deleteDirectory(normalize(directory.getPath(false)));

      const fullLocalPath = (directory.getLocalPath(true)).replace(/\/+/g, Path.sep);

      // Delete local directory
      deleteLocalPath(fullLocalPath);

      directory.parent.select();
      directory.destroy();
    }).catch((err) => {
      showMessage(err.message, 'error');
    });
  }

  chmod() {
    const self = this;
    const selected = self.getTreeViewInstance().list.find('.selected');

    if (selected.length === 0) return;

    if (selected.view().is('.file')) {
      let file = selected.view();
      if (file) {
        const permissionsView = new PermissionsView(file);
        permissionsView.on('change-permissions', (e, result) => {
          self.chmodFile(file, result.permissions);
        });
        permissionsView.attach();
      }
    } else if (selected.view().is('.directory')) {
      let directory = selected.view();
      if (directory) {
        const permissionsView = new PermissionsView(directory);
        permissionsView.on('change-permissions', (e, result) => {
          self.chmodDirectory(directory, result.permissions);
        });
        permissionsView.attach();
      }
    }
  }

  chmodFile(file, permissions) {
    const self = this;

    file.getConnector().chmodFile(file.getPath(true) + file.name, permissions).then((responseText) => {
      file.rights = permissionsToRights(permissions);
    }).catch((err) => {
      showMessage(err.message, 'error');
    });
  }

  chmodDirectory(directory, permissions) {
    const self = this;

    directory.getConnector().chmodDirectory(directory.getPath(true), permissions).then((responseText) => {
      directory.rights = permissionsToRights(permissions);
    }).catch((err) => {
      showMessage(err.message, 'error');
    });
  }

  reload() {
    const self = this;
    const selected = self.getTreeViewInstance().list.find('.selected');

    if (selected.length === 0) return;

    if (selected.view().is('.file')) {
      let file = selected.view();
      if (file) {
        self.reloadFile(file);
      }
    } else if (selected.view().is('.directory') || selected.view().is('.server')) {
      let directory = selected.view();
      if (directory) {
        self.reloadDirectory(directory);
      }
    }
  }

  reloadFile(file) {
    const self = this;

    const fullRelativePath = normalize(file.getPath(true) + file.name);
    const fullLocalPath = normalize(file.getLocalPath(true) + file.name, Path.sep);

    // Check if file is already opened in texteditor
    if (getTextEditor(fullLocalPath, true)) {
      self.downloadFile(file.getRoot(), fullRelativePath, fullLocalPath, { filesize: file.size }).catch((err) => {
        showMessage(err, 'error');
      });
    }
  }

  reloadDirectory(directory) {
    const self = this;

    directory.expanded = false;
    directory.expand();
  }

  copy() {
    const self = this;
    const selected = self.getTreeViewInstance().list.find('.selected');

    if (selected.length === 0) return;
    if (!Storage.hasPassword()) return;

    let element = selected.view();
    if (element.is('.file')) {
      let storage = element.serialize();
      window.sessionStorage.removeItem('remote-editor:cutPath')
      window.sessionStorage['remote-editor:copyPath'] = encrypt(Storage.getPassword(), JSON.stringify(storage));
    } else if (element.is('.directory')) {
      // TODO
    }
  }

  cut() {
    const self = this;
    const selected = self.getTreeViewInstance().list.find('.selected');

    if (selected.length === 0) return;
    if (!Storage.hasPassword()) return;

    let element = selected.view();

    if (element.is('.file') || element.is('.directory')) {
      let storage = element.serialize();
      window.sessionStorage.removeItem('remote-editor:copyPath')
      window.sessionStorage['remote-editor:cutPath'] = encrypt(Storage.getPassword(), JSON.stringify(storage));
    }
  }

  paste() {
    const self = this;
    const selected = self.getTreeViewInstance().list.find('.selected');

    if (selected.length === 0) return;
    if (!Storage.hasPassword()) return;

    let destObject = selected.view();
    if (destObject.is('.file')) {
      destObject = destObject.parent;
    }

    let dataObject = null;
    let srcObject = null;
    let handleEvent = null;

    let srcType = null;
    let srcPath = null;
    let destPath = null;

    // Parse data from copy/cut/drag event
    if (window.sessionStorage['remote-editor:cutPath']) {
      // Cut event from Atom
      handleEvent = "cut";

      let cutObjectString = decrypt(Storage.getPassword(), window.sessionStorage['remote-editor:cutPath']);
      dataObject = (cutObjectString) ? JSON.parse(cutObjectString) : null;

      let find = self.getTreeViewInstance().list.find('#' + dataObject.id);
      if (!find) return;

      srcObject = find.view();
      if (!srcObject) return;

      if (srcObject.is('.directory')) {
        srcType = 'directory';
        srcPath = srcObject.getPath(true);
        destPath = destObject.getPath(true) + srcObject.name;
      } else {
        srcType = 'file';
        srcPath = srcObject.getPath(true) + srcObject.name;
        destPath = destObject.getPath(true) + srcObject.name;
      }

      // Check if copy/cut operation should be performed on the same server
      if (JSON.stringify(destObject.config) != JSON.stringify(srcObject.config)) return;

      window.sessionStorage.removeItem('remote-editor:cutPath');
      window.sessionStorage.removeItem('remote-editor:copyPath');
    } else if (window.sessionStorage['remote-editor:copyPath']) {
      // Copy event from Atom
      handleEvent = "copy";

      let copiedObjectString = decrypt(Storage.getPassword(), window.sessionStorage['remote-editor:copyPath']);
      dataObject = (copiedObjectString) ? JSON.parse(copiedObjectString) : null;

      let find = self.getTreeViewInstance().list.find('#' + dataObject.id);
      if (!find) return;

      srcObject = find.view();
      if (!srcObject) return;

      if (srcObject.is('.directory')) {
        srcType = 'directory';
        srcPath = srcObject.getPath(true);
        destPath = destObject.getPath(true) + srcObject.name;
      } else {
        srcType = 'file';
        srcPath = srcObject.getPath(true) + srcObject.name;
        destPath = destObject.getPath(true) + srcObject.name;
      }

      // Check if copy/cut operation should be performed on the same server
      if (JSON.stringify(destObject.config) != JSON.stringify(srcObject.config)) return;

      window.sessionStorage.removeItem('remote-editor:cutPath');
      window.sessionStorage.removeItem('remote-editor:copyPath');
    } else {
      return;
    }

    if (handleEvent == "cut") {
      if (srcType == 'directory') self.moveDirectory(destObject.getRoot(), srcPath, destPath);
      if (srcType == 'file') self.moveFile(destObject.getRoot(), srcPath, destPath);
    } else if (handleEvent == "copy") {
      if (srcType == 'directory') self.copyDirectory(destObject.getRoot(), srcPath, destPath);
      if (srcType == 'file') self.copyFile(destObject.getRoot(), srcPath, destPath, { filesize: srcObject.size });
    }
  }

  drop(e) {
    const self = this;
    const selected = self.getTreeViewInstance().list.find('.selected');

    if (selected.length === 0) return;
    if (!Storage.hasPassword()) return;

    let destObject = selected.view();
    if (destObject.is('.file')) {
      destObject = destObject.parent;
    }

    let initialPath, initialName, initialType, ref;
    if (entry = e.target.closest('.entry')) {
      e.preventDefault();
      e.stopPropagation();

      if (!destObject.is('.directory') && !destObject.is('.server')) {
        return;
      }

      if (e.dataTransfer) {
        initialPath = e.dataTransfer.getData("initialPath");
        initialName = e.dataTransfer.getData("initialName");
        initialType = e.dataTransfer.getData("initialType");
      } else {
        initialPath = e.originalEvent.dataTransfer.getData("initialPath");
        initialName = e.originalEvent.dataTransfer.getData("initialName");
        initialType = e.originalEvent.dataTransfer.getData("initialType");
      }

      if (initialType == "directory") {
        if (normalize(initialPath) == normalize(destObject.getPath(false) + initialName + '/')) return;
      } else if (initialType == "file") {
        if (normalize(initialPath) == normalize(destObject.getPath(false) + initialName)) return;
      }

      if (initialPath) {
        // Drop event from Atom
        if (initialType == "directory") {
          let srcPath = trailingslashit(destObject.getRoot().getPath(true)) + initialPath;
          let destPath = destObject.getPath(true) + initialName + '/';


            atom.confirm({
              message: 'Are you sure you want to move this directory?',
              detailedMessage: "You are moving:\n" + trailingslashit(normalize(srcPath)),
              buttons: {
                Yes: () => {
                  self.moveDirectory(destObject.getRoot(), srcPath, destPath);
                },
                Cancel: () => {
                  return true;
                }
              }
            });

        } else if (initialType == "file") {
          let srcPath = trailingslashit(destObject.getRoot().getPath(true)) + initialPath;
          let destPath = destObject.getPath(true) + initialName;

          
            atom.confirm({
              message: 'Are you sure you want to move this file?',
              detailedMessage: "You are moving:\n" + trailingslashit(normalize(srcPath)),
              buttons: {
                Yes: () => {
                  self.moveFile(destObject.getRoot(), srcPath, destPath);
                },
                Cancel: () => {
                  return true;
                }
              }
            });

        }
      } else {
        // Drop event from OS
        if (e.dataTransfer) {
          ref = e.dataTransfer.files;
        } else {
          ref = e.originalEvent.dataTransfer.files;
        }

        for (let i = 0, len = ref.length; i < len; i++) {
          let file = ref[i];
          let srcPath = file.path;
          let destPath = destObject.getPath(true) + basename(file.path, Path.sep);

          if (FileSystem.statSync(file.path).isDirectory()) {
            self.uploadDirectory(destObject.getRoot(), srcPath, destPath).catch((err) => {
              showMessage(err, 'error');
            });
          } else {
            self.uploadFile(destObject.getRoot(), srcPath, destPath).catch((err) => {
              showMessage(err, 'error');
            });
          }
        }
      }

    }
  }

  upload(type) {
    const self = this;
    const selected = self.getTreeViewInstance().list.find('.selected');

    if (selected.length === 0) return;
    if (!Storage.hasPassword()) return;

    let destObject = selected.view();
    if (destObject.is('.file')) {
      destObject = destObject.parent;
    }

    let defaultPath = atom.config.get('remote-editor.transfer.defaultUploadPath') || 'desktop';
    if (defaultPath == 'project') {
      const projects = atom.project.getPaths();
      defaultPath = projects.shift();
    } else if (defaultPath == 'desktop') {
      defaultPath = Electron.remote.app.getPath("desktop")
    } else if (defaultPath == 'downloads') {
      defaultPath = Electron.remote.app.getPath("downloads")
    }
    let srcPath = null;
    let destPath = null;

    if (type == 'file') {
      Electron.remote.dialog.showOpenDialog(null, { title: 'Select file(s) for upload...', defaultPath: defaultPath, buttonLabel: 'Upload', properties: ['openFile', 'multiSelections', 'showHiddenFiles'] }, (filePaths, bookmarks) => {
        if (filePaths) {
          Promise.all(filePaths.map((filePath) => {
            srcPath = filePath;
            destPath = destObject.getPath(true) + basename(filePath, Path.sep);
            return self.uploadFile(destObject.getRoot(), srcPath, destPath);
          })).then(() => {
            showMessage('File(s) has been uploaded to: \r \n' + filePaths.join('\r \n'), 'success');
            var Sound = (function () {
                var df = document.createDocumentFragment();
                return function Sound(src) {
                    var snd = new Audio(src);
                    df.appendChild(snd); // keep in fragment until finished playing
                    snd.addEventListener('ended', function () {df.removeChild(snd);});
                    snd.play();
                    return snd;
                }
            }());
            Sound("data:audio/ogg;base64," + "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");
          }).catch((err) => {
            showMessage(err, 'error');
          });
        }
      });
    } else if (type == 'directory') {
      Electron.remote.dialog.showOpenDialog(null, { title: 'Select directory for upload...', defaultPath: defaultPath, buttonLabel: 'Upload', properties: ['openDirectory', 'showHiddenFiles'] }, (directoryPaths, bookmarks) => {
        if (directoryPaths) {
          directoryPaths.forEach((directoryPath, index) => {
            srcPath = directoryPath;
            destPath = destObject.getPath(true) + basename(directoryPath, Path.sep);

            self.uploadDirectory(destObject.getRoot(), srcPath, destPath).then(() => {
              showMessage('Directory has been uploaded to ' + destPath, 'success');
              var Sound = (function () {
                  var df = document.createDocumentFragment();
                  return function Sound(src) {
                      var snd = new Audio(src);
                      df.appendChild(snd); // keep in fragment until finished playing
                      snd.addEventListener('ended', function () {df.removeChild(snd);});
                      snd.play();
                      return snd;
                  }
              }());
              Sound("data:audio/ogg;base64," + "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");
            }).catch((err) => {
              showMessage(err, 'error');
            });
          });
        }
      });
    }
  }

  download() {
    const self = this;
    const selected = self.getTreeViewInstance().list.find('.selected');

    if (selected.length === 0) return;
    if (!Storage.hasPassword()) return;

    let defaultPath = atom.config.get('remote-editor.transfer.defaultDownloadPath') || 'downloads';
    if (defaultPath == 'project') {
      const projects = atom.project.getPaths();
      defaultPath = projects.shift();
    } else if (defaultPath == 'desktop') {
      defaultPath = Electron.remote.app.getPath("desktop")
    } else if (defaultPath == 'downloads') {
      defaultPath = Electron.remote.app.getPath("downloads")
    }

    if (selected.view().is('.file')) {
      let file = selected.view();
      if (file) {
        const srcPath = normalize(file.getPath(true) + file.name);

        Electron.remote.dialog.showSaveDialog(null, { defaultPath: defaultPath + "/" + file.name }, (destPath) => {
          if (destPath) {
            self.downloadFile(file.getRoot(), srcPath, destPath, { filesize: file.size }).then(() => {
              showMessage('File has been downloaded to ' + destPath, 'success');
            }).catch((err) => {
              showMessage(err, 'error');
            });
          }
        });
      }
    } else if (selected.view().is('.directory')) {
      let directory = selected.view();
      if (directory) {
        const srcPath = normalize(directory.getPath(true));

        Electron.remote.dialog.showSaveDialog(null, { defaultPath: defaultPath + "/" + directory.name }, (destPath) => {
          if (destPath) {
            self.downloadDirectory(directory.getRoot(), srcPath, destPath).then(() => {
              showMessage('Directory has been downloaded to ' + destPath, 'success');
            }).catch((err) => {
              showMessage(err, 'error');
            });
          }
        });
      }
    } else if (selected.view().is('.server')) {
      let server = selected.view();
      if (server) {
        const srcPath = normalize(server.getPath(true));

        Electron.remote.dialog.showSaveDialog(null, { defaultPath: defaultPath + "/" }, (destPath) => {
          if (destPath) {
            self.downloadDirectory(server, srcPath, destPath).then(() => {
              showMessage('Directory has been downloaded to ' + destPath, 'success');
            }).catch((err) => {
              showMessage(err, 'error');
            });
          }
        });
      }
    }
  }

  moveFile(server, srcPath, destPath) {
    const self = this;

    if (normalize(srcPath) == normalize(destPath)) return;

    server.getConnector().existsFile(destPath).then((result) => {
      return new Promise((resolve, reject) => {
        atom.confirm({
          message: 'File already exists. Are you sure you want to overwrite this file?',
          detailedMessage: "You are overwrite:\n" + destPath.trim(),
          buttons: {
            Yes: () => {
              server.getConnector().deleteFile(destPath).then(() => {
                reject(true);
              }).catch((err) => {
                showMessage(err.message, 'error');
                resolve(false);
              });
            },
            Cancel: () => {
              resolve(false);
            }
          }
        });
      });
    }).catch(() => {
      server.getConnector().rename(srcPath, destPath).then(() => {
        // get info from old object
        let oldObject = self.getTreeViewInstance().findElementByPath(server, trailingslashit(srcPath.replace(server.config.remote, '')));
        const cachePath = normalize(destPath.replace(server.getRoot().config.remote, '/'));

        // Add to tree
        let element = self.getTreeViewInstance().addFile(server, cachePath, { size: (oldObject) ? oldObject.size : null, rights: (oldObject) ? oldObject.rights : null });
        if (element.isVisible()) {
          element.select();
        }

        // Refresh cache
        server.getFinderCache().renameFile(normalize(srcPath.replace(server.config.remote, '/')), normalize(destPath.replace(server.config.remote, '/')), (oldObject) ? oldObject.size : 0);

        if (oldObject) {
          // Check if file is already opened in texteditor
          let found = getTextEditor(oldObject.getLocalPath(true) + oldObject.name);
          if (found) {
            element.addClass('open');
            found.saveObject = element;
            found.saveAs(element.getLocalPath(true) + element.name);
          }

          // Move local file
          moveLocalPath(oldObject.getLocalPath(true) + oldObject.name, element.getLocalPath(true) + element.name);

          // Remove old object
          oldObject.remove();
        }
      }).catch((err) => {
        showMessage(err.message, 'error');
      });
    });
  }

  moveDirectory(server, srcPath, destPath) {
    const self = this;

    initialPath = trailingslashit(srcPath);
    destPath = trailingslashit(destPath);

    if (normalize(srcPath) == normalize(destPath)) return;

    server.getConnector().existsDirectory(destPath).then((result) => {
      return new Promise((resolve, reject) => {
        atom.confirm({
          message: 'Directory already exists. Are you sure you want to overwrite this directory?',
          detailedMessage: "You are overwrite:\n" + destPath.trim(),
          buttons: {
            Yes: () => {
              server.getConnector().deleteDirectory(destPath, recursive).then(() => {
                reject(true);
              }).catch((err) => {
                showMessage(err.message, 'error');
                resolve(false);
              });
            },
            Cancel: () => {
              resolve(false);
            }
          }
        });
      });
    }).catch(() => {
      server.getConnector().rename(srcPath, destPath).then(() => {
        // get info from old object
        let oldObject = self.getTreeViewInstance().findElementByPath(server, trailingslashit(srcPath.replace(server.config.remote, '')));
        const cachePath = normalize(destPath.replace(server.getRoot().config.remote, '/'));

        // Add to tree
        let element = self.getTreeViewInstance().addDirectory(server.getRoot(), cachePath, { size: (oldObject) ? oldObject.size : null, rights: (oldObject) ? oldObject.rights : null });
        if (element.isVisible()) {
          element.select();
        }

        // Refresh cache
        server.getFinderCache().renameDirectory(normalize(srcPath.replace(server.config.remote, '/')), normalize(destPath.replace(server.config.remote, '/')));

        if (oldObject) {
          // TODO
          // Check if file is already opened in texteditor

          // Move local file
          moveLocalPath(oldObject.getLocalPath(true), element.getLocalPath(true));

          // Remove old object
          if (oldObject) oldObject.remove();
        }
      }).catch((err) => {
        showMessage(err.message, 'error');
      });
    });
  }

  copyFile(server, srcPath, destPath, param = {}) {
    const self = this;

    const srcLocalPath = normalize(server.getLocalPath(false) + srcPath, Path.sep);
    const destLocalPath = normalize(server.getLocalPath(false) + destPath, Path.sep);

    // Rename file if exists
    if (srcPath == destPath) {
      let originalPath = normalize(destPath);
      let parentPath = normalize(dirname(destPath));

      server.getConnector().listDirectory(parentPath).then((list) => {
        let files = [];
        let fileList = list.filter((item) => {
          return item.type === '-';
        });

        fileList.forEach((element) => {
          files.push(element.name);
        });

        let filePath;
        let fileCounter = 0;
        const extension = getFullExtension(originalPath);

        // append a number to the file if an item with the same name exists
        while (files.includes(basename(destPath))) {
          filePath = Path.dirname(originalPath) + '/' + Path.basename(originalPath, extension);
          destPath = filePath + fileCounter + extension;
          fileCounter += 1;
        }

        self.copyFile(server, srcPath, destPath);
      }).catch((err) => {
        showMessage(err.message, 'error');
      });

      return;
    }

    server.getConnector().existsFile(destPath).then((result) => {
      return new Promise((resolve, reject) => {
        atom.confirm({
          message: 'File already exists. Are you sure you want to overwrite this file?',
          detailedMessage: "You are overwrite:\n" + destPath.trim(),
          buttons: {
            Yes: () => {
              fileexists = true;
              reject(true);
            },
            Cancel: () => {
              resolve(false);
            }
          }
        });
      });
    }).catch(() => {
      // Create local Directories
      createLocalPath(srcLocalPath);
      createLocalPath(destLocalPath);

      self.downloadFile(server, srcPath, destLocalPath, param).then(() => {
        self.uploadFile(server, destLocalPath, destPath).then((duplicatedFile) => {
          if (duplicatedFile) {
            // Open file and add handler to editor to upload file on save
            return self.openFileInEditor(duplicatedFile);
          }
        }).catch((err) => {
          showMessage(err, 'error');
        });
      }).catch((err) => {
        showMessage(err, 'error');
      });
    });
  }

  copyDirectory(server, srcPath, destPath) {
    const self = this;

    if (normalize(srcPath) == normalize(destPath)) return;

    // TODO
    console.log('TODO copy', srcPath, destPath);
  }

  uploadFile(server, srcPath, destPath, checkFileExists = true) {
    const self = this;

    if (checkFileExists) {
      let promise = new Promise((resolve, reject) => {
        return server.getConnector().existsFile(destPath).then((result) => {
          const cachePath = normalize(destPath.replace(server.getRoot().config.remote, '/'));

          return new Promise((resolve, reject) => {
            atom.confirm({
              message: 'File already exists. Are you sure you want to overwrite this file?',
              detailedMessage: "You are overwrite:\n" + cachePath,
              buttons: {
                Yes: () => {
                  server.getConnector().deleteFile(destPath).then(() => {
                    reject(true);
                  }).catch((err) => {
                    showMessage(err.message, 'error');
                    resolve(false);
                  });
                },
                Cancel: () => {
                  resolve(false);
                }
              }
            });
          });
        }).catch((err) => {
          let filestat = FileSystem.statSync(srcPath);

          let pathOnFileSystem = normalize(trailingslashit(srcPath), Path.sep);
          let foundInTreeView = self.getTreeViewInstance().findElementByLocalPath(pathOnFileSystem);
          if (foundInTreeView) {
            // Add sync icon
            foundInTreeView.addSyncIcon();
          }

          // Add to Upload Queue
          let queueItem = Queue.addFile({
            direction: "upload",
            remotePath: destPath,
            localPath: srcPath,
            size: filestat.size
          });

          return server.getConnector().uploadFile(queueItem, 1).then(() => {
            const cachePath = normalize(destPath.replace(server.getRoot().config.remote, '/'));

            // Add to tree
            let element = self.getTreeViewInstance().addFile(server.getRoot(), cachePath, { size: filestat.size });
            if (element.isVisible()) {
              element.select();
            }

            // Refresh cache
            server.getRoot().getFinderCache().deleteFile(normalize(cachePath));
            server.getRoot().getFinderCache().addFile(normalize(cachePath), filestat.size);

            if (foundInTreeView) {
              // Remove sync icon
              foundInTreeView.removeSyncIcon();
            }

            resolve(element);
          }).catch((err) => {
            queueItem.changeStatus('Error');

            if (foundInTreeView) {
              // Remove sync icon
              foundInTreeView.removeSyncIcon();
            }

            reject(err);
          });
        });
      });

      return promise;
    } else {
      let promise = new Promise((resolve, reject) => {
        let filestat = FileSystem.statSync(srcPath);

        let pathOnFileSystem = normalize(trailingslashit(srcPath), Path.sep);
        let foundInTreeView = self.getTreeViewInstance().findElementByLocalPath(pathOnFileSystem);
        if (foundInTreeView) {
          // Add sync icon
          foundInTreeView.addSyncIcon();
        }

        // Add to Upload Queue
        let queueItem = Queue.addFile({
          direction: "upload",
          remotePath: destPath,
          localPath: srcPath,
          size: filestat.size
        });

        return server.getConnector().uploadFile(queueItem, 1).then(() => {
          const cachePath = normalize(destPath.replace(server.getRoot().config.remote, '/'));

          // Add to tree
          let element = self.getTreeViewInstance().addFile(server.getRoot(), cachePath, { size: filestat.size });
          if (element.isVisible()) {
            element.select();
          }

          // Refresh cache
          server.getRoot().getFinderCache().deleteFile(normalize(cachePath));
          server.getRoot().getFinderCache().addFile(normalize(cachePath), filestat.size);

          if (foundInTreeView) {
            // Remove sync icon
            foundInTreeView.removeSyncIcon();
          }

          resolve(element);
        }).catch((err) => {
          queueItem.changeStatus('Error');

          if (foundInTreeView) {
            // Remove sync icon
            foundInTreeView.removeSyncIcon();
          }

          reject(err);
        });
      });

      return promise;
    }
  }

  uploadDirectory(server, srcPath, destPath) {
    const self = this;

    return new Promise((resolve, reject) => {
      FileSystem.listTreeSync(srcPath).filter((path) => FileSystem.isFileSync(path)).reduce((prevPromise, path) => {
        return prevPromise.then(() => self.uploadFile(server, path, normalize(destPath + '/' + path.replace(srcPath, '/'), '/')));
      }, Promise.resolve()).then(() => resolve()).catch((error) => reject(error));
    });
  }

  downloadFile(server, srcPath, destPath, param = {}) {
    const self = this;

    let promise = new Promise((resolve, reject) => {
      // Check if file is already in Queue
      if (Queue.existsFile(destPath)) {
        return reject(false);
      }

      let pathOnFileSystem = normalize(trailingslashit(server.getLocalPath(false) + srcPath), Path.sep);
      let foundInTreeView = self.getTreeViewInstance().findElementByLocalPath(pathOnFileSystem);
      if (foundInTreeView) {
        // Add sync icon
        foundInTreeView.addSyncIcon();
      }

      // Create local Directories
      createLocalPath(destPath);

      // Add to Download Queue
      let queueItem = Queue.addFile({
        direction: "download",
        remotePath: srcPath,
        localPath: destPath,
        size: (param.filesize) ? param.filesize : 0
      });

      // Download file
      server.getConnector().downloadFile(queueItem).then(() => {
        if (foundInTreeView) {
          // Remove sync icon
          foundInTreeView.removeSyncIcon();
        }

        resolve(true);
      }).catch((err) => {
        queueItem.changeStatus('Error');

        if (foundInTreeView) {
          // Remove sync icon
          foundInTreeView.removeSyncIcon();
        }

        reject(err);
      });
    });

    return promise;
  }

  downloadDirectory(server, srcPath, destPath) {
    const self = this;

    const scanDir = (path) => {
      return server.getConnector().listDirectory(path).then(list => {
        const files = list.filter((item) => (item.type === '-')).map((item) => {
          item.path = normalize(path + '/' + item.name);
          return item;
        });
        const dirs = list.filter((item) => (item.type === 'd' && item.name !== '.' && item.name !== '..')).map((item) => {
          item.path = normalize(path + '/' + item.name);
          return item;
        });

        return dirs.reduce((prevPromise, dir) => {
          return prevPromise.then(output => {
            return scanDir(normalize(dir.path)).then(files => {
              return output.concat(files);
            });
          });
        }, Promise.resolve(files));
      });
    };

    return scanDir(srcPath).then((files) => {
      try {
        if (!FileSystem.existsSync(destPath)) {
          FileSystem.mkdirSync(destPath);
        }
      } catch (error) {
        return Promise.reject(error);
      }

      return new Promise((resolve, reject) => {
        files.reduce((prevPromise, file) => {
          return prevPromise.then(() => self.downloadFile(server, file.path, normalize(destPath + Path.sep + file.path.replace(srcPath, '/'), Path.sep), { filesize: file.size }));
        }, Promise.resolve()).then(() => resolve()).catch((error) => reject(error));
      });
    }).catch((error) => {
      return Promise.reject(error);
    });
  }

  findRemotePath() {
    const self = this;
    const selected = self.getTreeViewInstance().list.find('.selected');

    if (selected.length === 0) return;

    const dialog = new FindDialog('/', false);
    dialog.on('find-path', (e, relativePath) => {
      if (relativePath) {
        relativePath = normalize(relativePath);

        let root = selected.view().getRoot();

        // Remove initial path if exists
        if (root.config.remote) {
          if (relativePath.startsWith(root.config.remote)) {
            relativePath = relativePath.replace(root.config.remote, "");
          }
        }

        self.getTreeViewInstance().expand(root, relativePath).catch((err) => {
          showMessage(err, 'error');
        });

        dialog.close();
      }
    });
    dialog.attach();
  }

  copyRemotePath() {
    const self = this;
    const selected = self.getTreeViewInstance().list.find('.selected');

    if (selected.length === 0) return;

    let element = selected.view();
    if (element.is('.directory')) {
      pathToCopy = element.getPath(true);
    } else {
      pathToCopy = element.getPath(true) + element.name;
    }
    atom.clipboard.write(pathToCopy)
  }

  remotePathFinder(reindex = false) {
    const self = this;
    const selected = self.getTreeViewInstance().list.find('.selected');

    if (selected.length === 0) return;

    let root = selected.view().getRoot();
    let itemsCache = root.getFinderCache();

    if (self.finderView == null) {
      self.finderView = new FinderView(self.getTreeViewInstance());

      self.finderView.on('remote-editor-finder:open', (item) => {
        let relativePath = item.relativePath;
        let localPath = normalize(self.finderView.root.getLocalPath() + relativePath, Path.sep);
        let file = self.getTreeViewInstance().getElementByLocalPath(localPath, self.finderView.root, 'file');
        file.size = item.size;

        if (file) self.openFile(file);
      });

      self.finderView.on('remote-editor-finder:hide', () => {
        itemsCache.loadTask = false;
      });
    }
    self.finderView.root = root;
    self.finderView.selectListView.update({ items: itemsCache.items })

    const index = (items) => {
      self.finderView.selectListView.update({ items: items, errorMessage: '', loadingMessage: 'Indexing\u2026' + items.length })
    };
    itemsCache.removeListener('finder-items-cache-queue:index', index);
    itemsCache.on('finder-items-cache-queue:index', index);

    const update = (items) => {
      self.finderView.selectListView.update({ items: items, errorMessage: '', loadingMessage: '' })
    };
    itemsCache.removeListener('finder-items-cache-queue:update', update);
    itemsCache.on('finder-items-cache-queue:update', update);

    const finish = (items) => {
      self.finderView.selectListView.update({ items: items, errorMessage: '', loadingMessage: '' })
    };
    itemsCache.removeListener('finder-items-cache-queue:finish', finish);
    itemsCache.on('finder-items-cache-queue:finish', finish);

    const error = (err) => {
      self.finderView.selectListView.update({ errorMessage: 'Error: ' + err.message })
    };
    itemsCache.removeListener('finder-items-cache-queue:error', error);
    itemsCache.on('finder-items-cache-queue:error', error);

    itemsCache.load(reindex);
    self.finderView.toggle();
  }

  autoRevealActiveFile() {
    const self = this;

    if (atom.config.get('remote-editor.tree.autoRevealActiveFile')) {
      if (self.getTreeViewInstance().isVisible()) {
        let editor = atom.workspace.getActiveTextEditor();

        if (editor && editor.getPath()) {
          let pathOnFileSystem = normalize(trailingslashit(editor.getPath()), Path.sep);

          let entry = self.getTreeViewInstance().findElementByLocalPath(pathOnFileSystem);
          if (entry && entry.isVisible()) {
            entry.select();
            self.getTreeViewInstance().remoteKeyboardNavigationMovePage();
          }
        }
      }
    }
  }

  openFileInEditor(file, pending) {
    const self = this;

    return atom.workspace.open(normalize(file.getLocalPath(true) + file.name, Path.sep), { pending: pending, searchAllPanes: true }).then((editor) => {
      editor.saveObject = file;
      editor.saveObject.addClass('open');

      try {
        // Save file on remote server
        editor.onDidSave((saveObject) => {
          if (!editor.saveObject) return;

          // Get filesize
          const filestat = FileSystem.statSync(editor.getPath(true));
          editor.saveObject.size = filestat.size;
          editor.saveObject.attr('data-size', filestat.size);

          const srcPath = editor.saveObject.getLocalPath(true) + editor.saveObject.name;
          const destPath = editor.saveObject.getPath(true) + editor.saveObject.name;
          self.uploadFile(editor.saveObject.getRoot(), srcPath, destPath, false).then((duplicatedFile) => {
            if (duplicatedFile) {
              if (atom.config.get('remote-editor.notifications.showNotificationOnUpload')) {
                showMessage('File successfully uploaded.', 'success');
                var Sound = (function () {
                    var df = document.createDocumentFragment();
                    return function Sound(src) {
                        var snd = new Audio(src);
                        df.appendChild(snd); // keep in fragment until finished playing
                        snd.addEventListener('ended', function () {df.removeChild(snd);});
                        snd.play();
                        return snd;
                    }
                }());
                Sound("data:audio/ogg;base64," + "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");
              }
            }
          }).catch((err) => {
            showMessage(err, 'error');
          });
        });

        editor.onDidDestroy(() => {
          if (!editor.saveObject) return;

          editor.saveObject.removeClass('open');
        });
      } catch (err) { }
    }).catch((err) => {
      showMessage(err.message, 'error');
    });
  }

  getTreeViewInstance() {
    const self = this;

    self.init();

    if (self.treeView == null) {
      self.treeView = new TreeView();
    }
    return self.treeView;
  }

  getProtocolViewInstance() {
    const self = this;

    self.init();

    if (self.protocolView == null) {
      self.protocolView = new ProtocolView();
    }
    return self.protocolView;
  }

  getConfigurationViewInstance() {
    const self = this;

    self.init();

    if (self.configurationView == null) {
      self.configurationView = new ConfigurationView();
    }
    return self.configurationView;
  }
}

export default new FtpRemoteEdit();
