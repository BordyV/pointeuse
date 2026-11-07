// Permet d'importer ../shared/core.js (logique commune avec la version web).
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../shared')];

module.exports = config;
