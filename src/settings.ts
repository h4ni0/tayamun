import { storage } from '#imports';

export interface SiteSettings {
  enabled: boolean;
  alignRight: boolean;
  improveFont: boolean;
}

export type SettingsByHostname = Record<string, SiteSettings>;

export const DEFAULT_SITE_SETTINGS: Readonly<SiteSettings> = Object.freeze({
  enabled: true,
  alignRight: false,
  improveFont: false,
});

export const siteSettingsStorage = storage.defineItem<SettingsByHostname>(
  'local:siteSettingsByHostname',
  { fallback: {} },
);

function requireHostname(hostname: string): void {
  if (hostname.length === 0) {
    throw new TypeError('Hostname must not be empty.');
  }
}

function sameSiteSettings(left: SiteSettings, right: SiteSettings): boolean {
  return (
    left.enabled === right.enabled &&
    left.alignRight === right.alignRight &&
    left.improveFont === right.improveFont
  );
}

function resolveSiteSettings(
  settings?: Partial<SiteSettings> | null,
): SiteSettings {
  return {
    enabled:
      typeof settings?.enabled === 'boolean'
        ? settings.enabled
        : DEFAULT_SITE_SETTINGS.enabled,
    alignRight:
      typeof settings?.alignRight === 'boolean'
        ? settings.alignRight
        : DEFAULT_SITE_SETTINGS.alignRight,
    improveFont:
      typeof settings?.improveFont === 'boolean'
        ? settings.improveFont
        : DEFAULT_SITE_SETTINGS.improveFont,
  };
}

export async function getSiteSettings(hostname: string): Promise<SiteSettings> {
  requireHostname(hostname);
  const settingsByHostname = await siteSettingsStorage.getValue();
  return resolveSiteSettings(settingsByHostname[hostname]);
}

export async function setSiteSettings(
  hostname: string,
  settings: SiteSettings,
): Promise<void> {
  requireHostname(hostname);
  const settingsByHostname = await siteSettingsStorage.getValue();

  await siteSettingsStorage.setValue({
    ...settingsByHostname,
    [hostname]: resolveSiteSettings(settings),
  });
}

export async function updateSiteSettings(
  hostname: string,
  patch: Partial<SiteSettings>,
): Promise<SiteSettings> {
  const currentSettings = await getSiteSettings(hostname);
  const updatedSettings = resolveSiteSettings({ ...currentSettings, ...patch });
  await setSiteSettings(hostname, updatedSettings);
  return updatedSettings;
}

export function watchSiteSettings(
  hostname: string,
  callback: (settings: SiteSettings) => void,
): () => void {
  requireHostname(hostname);

  return siteSettingsStorage.watch((settingsByHostname, previousSettingsByHostname) => {
    const settings = resolveSiteSettings(settingsByHostname?.[hostname]);
    const previousSettings = resolveSiteSettings(previousSettingsByHostname?.[hostname]);
    if (!sameSiteSettings(settings, previousSettings)) callback(settings);
  });
}
