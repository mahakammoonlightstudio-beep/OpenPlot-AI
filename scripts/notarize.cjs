// electron-builder afterSign hook.
//
// Signing is driven by the standard electron-builder variables (CSC_LINK /
// CSC_KEY_PASSWORD). Notarization is opt-in: when the three Apple credentials
// are absent — a fork, a local build, or a maintainer without the secrets —
// the hook returns quietly and the build stays unsigned, exactly as before.
const path = require('node:path');

exports.default = async function notarizeMac(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !appleIdPassword || !teamId) {
    console.log('Skipping notarization: APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set');
    return;
  }

  const { notarize } = require('@electron/notarize');
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  console.log(`Notarizing ${appPath} (team ${teamId})`);
  await notarize({
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  });
  console.log(`Notarized ${appPath}`);
};
