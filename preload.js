

'use strict';

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('safebox', {
  platform: process.platform,
  isElectron: true,
});
