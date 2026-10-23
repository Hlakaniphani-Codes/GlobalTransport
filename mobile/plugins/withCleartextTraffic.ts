import { withAndroidManifest, type ConfigPlugin } from '@expo/config-plugins';

const withCleartextTraffic: ConfigPlugin = (config) =>
  withAndroidManifest(config, (manifestConfig) => {
    const application = manifestConfig.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error('Android manifest application is missing.');
    }

    application.$['android:usesCleartextTraffic'] = 'false';
    return manifestConfig;
  });

export default withCleartextTraffic;
