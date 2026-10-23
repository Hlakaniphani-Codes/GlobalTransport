import type { ExpoConfig } from 'expo/config';

const appIdentifier = process.env.APP_IDENTIFIER ?? 'com.clientname.globalride';
const easProjectId = process.env.EAS_PROJECT_ID?.trim();
const iosBuildNumber = process.env.IOS_BUILD_NUMBER ?? '1';
const androidVersionCode = Number.parseInt(process.env.ANDROID_VERSION_CODE ?? '1', 10);
const eas = easProjectId ? { projectId: easProjectId } : undefined;

function validateEasBuildConfiguration() {
  if (!process.env.EAS_BUILD_PROFILE) return;

  if (
    !process.env.APP_IDENTIFIER
    || process.env.APP_IDENTIFIER.includes('clientname')
    || !/^[a-zA-Z][a-zA-Z0-9_-]*(\.[a-zA-Z][a-zA-Z0-9_-]*)+$/.test(process.env.APP_IDENTIFIER)
  ) {
    throw new Error('Set APP_IDENTIFIER to the client-approved reverse-DNS app identifier before building with EAS.');
  }

  if (!easProjectId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(easProjectId)) {
    throw new Error('Set EAS_PROJECT_ID to the project UUID before building with EAS.');
  }

  for (const [name, value] of [
    ['EXPO_PUBLIC_API_URL', process.env.EXPO_PUBLIC_API_URL],
    ['EXPO_PUBLIC_LEGAL_BASE_URL', process.env.EXPO_PUBLIC_LEGAL_BASE_URL],
  ]) {
    let url: URL;
    try {
      url = new URL(value ?? '');
    } catch {
      throw new Error(`${name} must be set to the deployed HTTPS service origin before building with EAS.`);
    }

    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
      || /example|placeholder|\.invalid$/i.test(url.hostname)
    ) {
      throw new Error(`${name} must be a real HTTPS service origin without a path before building with EAS.`);
    }
  }
}

validateEasBuildConfiguration();

const config: ExpoConfig = {
  name: 'Global Ride Transport',
  slug: 'global-ride-transport',
  version: '1.0.0',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  icon: './assets/images/brand-icon.png',
  scheme: 'globalride',
  ios: {
    bundleIdentifier: appIdentifier,
    buildNumber: iosBuildNumber,
  },
  android: {
    package: appIdentifier,
    versionCode: androidVersionCode,
    permissions: ['android.permission.POST_NOTIFICATIONS'],
    softwareKeyboardLayoutMode: 'resize',
    adaptiveIcon: {
      backgroundColor: '#FFFFFF',
      foregroundImage: './assets/images/brand-icon.png',
    },
    predictiveBackGestureEnabled: false,
  },
  web: {
    output: 'static',
    favicon: './assets/images/brand-icon.png',
  },
  plugins: [
    'expo-router',
    [
      'expo-notifications',
      {
        icon: './assets/images/android-icon-monochrome.png',
        color: '#1769AA',
        defaultChannel: 'general',
      },
    ],
    './plugins/withCleartextTraffic',
    [
      'expo-splash-screen',
      {
        backgroundColor: '#FFFFFF',
        image: './assets/images/brand-icon.png',
        imageWidth: 220,
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: {
    eas,
  },
};

export default config;
