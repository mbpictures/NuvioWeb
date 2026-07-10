const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");
const {
  getKeplerCompatibilityMetroConfig
} = require("@amazon-devices/kepler-compatibility-metro-config");

module.exports = mergeConfig(getDefaultConfig(__dirname), getKeplerCompatibilityMetroConfig());
