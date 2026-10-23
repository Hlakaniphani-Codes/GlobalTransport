# Global Ride Transport mobile app

## Build configuration

The app reads its native identifiers from `APP_IDENTIFIER` and its EAS project
UUID from `EAS_PROJECT_ID`. Configure these, `EXPO_PUBLIC_API_URL`, and
`EXPO_PUBLIC_LEGAL_BASE_URL` in the EAS environment used by each build profile.
EAS builds fail early when these values are missing, use example domains, or
are not valid HTTPS service origins. These `EXPO_PUBLIC_` values are included
in the app and must not contain secrets.

Copy `.env.example` to `.env` for local development and set the values for the
client's deployment. Do not commit `.env`. Production builds stop at startup if
`EXPO_PUBLIC_API_URL` is missing or is not HTTPS. Android cleartext traffic is
disabled.

For local signup to work, `EXPO_PUBLIC_LEGAL_BASE_URL` must point to the
public admin website that serves `/terms` and `/privacy`. Set it in
`mobile/.env`, then restart Expo with a cleared cache:

```powershell
npx expo start --clear
```

For a deployed mobile app, set the same variable to the deployed HTTPS admin
site and rebuild the app. A physical phone cannot use `localhost` to reach the
development computer. In development builds on a physical device, the app
replaces a loopback `EXPO_PUBLIC_API_URL` host with Expo's private LAN host
when available. Start Expo in LAN mode and allow port 3000 through the
development computer's firewall. For Expo tunnel mode, use a reachable API
URL instead.

After creating the app in Expo, set `EAS_PROJECT_ID` to its project UUID. EAS
build profiles are:

```powershell
npx eas-cli login
npx eas-cli build --profile development --platform all
npx eas-cli build --profile preview --platform android
npx eas-cli build --profile production --platform all
```

## Android push notification development

The Android warning about remote notifications in Expo Go is expected: Expo
SDK 53 and later do not support remote push notifications in Expo Go on Android.
Do not suppress the warning or use Expo Go to verify push delivery. This project
includes `expo-dev-client` and an EAS `development` profile for a custom app
build that contains the notification native module.

Set the approved `APP_IDENTIFIER`, `EAS_PROJECT_ID`, `EXPO_PUBLIC_API_URL`, and
`EXPO_PUBLIC_LEGAL_BASE_URL` values in the build environment, then build and
install the Android development client:

```powershell
npx eas-cli login
npx eas-cli build --profile development --platform android
```

Open the installed Global Ride development app (not Expo Go), then start Metro
from `mobile`:

```powershell
npm start
```

Use a physical Android device for push-token registration and remote delivery.
Local notifications and the rest of the app can still be explored in Expo Go,
but Android remote push must be tested in the development build. Rebuild the
development client after changing native dependencies or notification config.
The default `npm start`, `npm run android`, and `npm run ios` commands target
the development client. To intentionally open Expo Go for UI-only work, use
`npm run start:expo-go`; its Android push warning is expected.

## Brand assets

Supply approved Global Ride Transport artwork before store builds:

- App icon: `assets/images/icon.png`, 1024x1024, fully opaque (no transparency).
- Android adaptive foreground: `assets/images/android-icon-foreground.png`,
  1024x1024 with transparency where required by the design.
- Splash artwork: `assets/images/splash-icon.png`, high-resolution approved
  artwork sized for the intended splash layout.

The current repository contains Expo starter artwork, and the adaptive
foreground is 512x512. It is not confirmed as approved brand artwork and does
not meet the required adaptive-foreground dimensions. Replace these files with
client-approved assets before production release; no placeholder artwork is
provided by this project.
