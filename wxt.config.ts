import { defineConfig } from 'wxt';

const supportedSites = ['http://*/*', 'https://*/*'];

export default defineConfig({
  srcDir: 'src',
  manifestVersion: 3,
  targetBrowsers: ['chrome', 'firefox'],
  zip: {
    includeSources: ['tests/**'],
  },
  manifest: ({ browser }) => ({
    name: '__MSG_extensionName__',
    description: '__MSG_extensionDescription__',
    homepage_url: 'https://github.com/h4ni0/tayamun',
    default_locale: 'ar',
    permissions: ['storage'],
    web_accessible_resources: [
      {
        resources: ['fonts/*.woff2', 'shadow-main-world.js'],
        matches: supportedSites,
      },
    ],
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'tayamun@tayamun-extension',
              data_collection_permissions: {
                required: ['none'],
              },
            },
          },
        }
      : {}),
  }),
});
