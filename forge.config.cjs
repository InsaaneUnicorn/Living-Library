const path = require('node:path')
const appIcon = path.join(__dirname, 'electron', 'app-icon')

module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'living-library',
    icon: appIcon,
    ignore: [/^\/(?:src|public|\.codex|\.vscode|out)(?:\/|$)/],
  },
  makers: [
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: (arch) => ({
        name: 'living_library',
        setupExe: `LivingLibrary-win32-${arch}-Setup.exe`,
        setupIcon: `${appIcon}.ico`,
      }),
    },
  ],
}
