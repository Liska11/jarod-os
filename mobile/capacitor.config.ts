import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'os.jarod.mobile',
  appName: 'Jarod',
  webDir: 'dist',
  server: {
    // The page is served from http://localhost: a secure context (WebCrypto works) whose origin the
    // bridge's /m1 routes accept. Requests to the PC are plain HTTP on the LAN or the tailnet, and
    // carry only the end-to-end channel's ciphertext (docs/ANDROID-APP.md §1).
    androidScheme: 'http',
    hostname: 'localhost'
  },
  android: {
    // No remote debugging in a release build; a debug build keeps it for development.
    webContentsDebuggingEnabled: false
  },
  plugins: {
    LocalNotifications: { iconColor: '#2f7dff' }
  }
}

export default config
