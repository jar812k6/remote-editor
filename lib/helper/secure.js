'use babel';

const atom = global.atom;
const crypto = require('crypto');

export const decrypt = (password, text) => {
  try {
    let decipher = crypto.createDecipher('aes-256-ctr', password);
    let dec = decipher.update(text, 'hex', 'utf8');
    return dec;
  } catch (e) {
    return null;
  }
}

export const encrypt = (password, text) => {
  try {
    let cipher = crypto.createCipher('aes-256-ctr', password);
    let crypted = cipher.update(text, 'utf8', 'hex');
    crypted += cipher.final('hex');
    return crypted;
  } catch (e) {
    return null;
  }
}

export const checkPasswordExists = () => {
  let passwordHash = atom.config.get('remote-editor.password');

  // migrate from remote-editor-plus
  if(!passwordHash){
    passwordHash = atom.config.get('remote-editor-plus.password');
    if (passwordHash) {
      let servers = atom.config.get('remote-editor-plus.servers');
      atom.config.set('remote-editor.config', servers);
      atom.config.set('remote-editor.password', passwordHash);
    }
  }
  if (passwordHash) return true;

  return false;
}

export const checkPassword = (password) => {
  let passwordHash = atom.config.get('remote-editor.password');
  if (!passwordHash) return true;

  if (decrypt(password, passwordHash) !== password) {
    return false;
  }

  return true;
}

export const setPassword = (password) => {
  let promise = new Promise((resolve, reject) => {
    let passwordHash = encrypt(password, password);

    // Store in atom config
    atom.config.set('remote-editor.password', passwordHash);

    resolve(true);
  });

  return promise;
}

export const changePassword = (oldPassword, newPassword) => {
  let promise = new Promise((resolve, reject) => {
    let passwordHash = encrypt(newPassword, newPassword);

    // Store in atom config
    atom.config.set('remote-editor.password', passwordHash);

    let configHash = atom.config.get('remote-editor.config');
    if (configHash) {
      let oldconfig = decrypt(oldPassword, configHash);
      let newconfig = encrypt(newPassword, oldconfig);

      let oldWhitelist = getHashList(oldPassword, 'remote-editor.allowedConsumers');
      let oldBlacklist = getHashList(oldPassword, 'remote-editor.disallowedConsumers');

      // Store in atom config
      atom.config.set('remote-editor.config', newconfig);
      setHashList(newPassword, 'remote-editor.allowedConsumers', oldWhitelist);
      setHashList(newPassword, 'remote-editor.disallowedConsumers', oldBlacklist);
    }

    resolve(true);
  });

  return promise;
}

export const isInWhiteList = (password, msg) => {
  let hashes = getHashList(password, 'remote-editor.allowedConsumers');
  return hashes.indexOf(msg) > -1
}

export const isInBlackList = (password, msg) => {
  let hashes = getHashList(password, 'remote-editor.disallowedConsumers');
  return hashes.indexOf(msg) > -1
}

export const addToWhiteList = (password, msg) => {
  addToHashList(password, 'remote-editor.allowedConsumers', msg);
}

export const addToBlackList = (password, msg) => {
  addToHashList(password, 'remote-editor.disallowedConsumers', msg);
}

const getHashList = (password, setting) => {
  let conf = atom.config.get(setting);
  if (conf) {
    try {
      return JSON.parse(decrypt(password, conf));
    } catch (ex) {
      return []
    }
  } else {
    return []
  }
}

const setHashList = (password, setting, hashes) => {
  try {
    let str = JSON.stringify(hashes);
    atom.config.set(setting, encrypt(password, str));
  } catch (ex) {
    return []
  }
}

const addToHashList = (password, setting, msg) => {
  let hashes = getHashList(password, setting);
  hashes.push(msg);
  let str = JSON.stringify(hashes);
  atom.config.set(setting, encrypt(password, str));
}

export const b64EncodeUnicode = (str) => {
  return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (match, p1) => {
    return String.fromCharCode('0x' + p1);
  }));
}

export const b64DecodeUnicode = (str) => {
  return decodeURIComponent(atob(str).split('').map((c) => {
    return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
  }).join(''));
}
