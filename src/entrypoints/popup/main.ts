import './style.css';
import { browser } from 'wxt/browser';
import { getSiteSettings, setSiteSettings, type SiteSettings } from '../../settings';

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing popup element: ${id}`);
  }
  return element as T;
}

const sitePanel = getElement<HTMLElement>('site-panel');
const restrictedPanel = getElement<HTMLElement>('restricted-panel');
const restrictedTitle = restrictedPanel.querySelector('strong');
const restrictedMessage = getElement<HTMLElement>('restricted-message');
const hostnameElement = getElement<HTMLElement>('hostname');
const settingsForm = getElement<HTMLFormElement>('settings-form');
const saveStatus = getElement<HTMLElement>('save-status');
const enabledInput = getElement<HTMLInputElement>('enabled');
const alignRightInput = getElement<HTMLInputElement>('align-right');
const improveFontInput = getElement<HTMLInputElement>('improve-font');

let hostname: string | null = null;
let saveQueue: Promise<void> = Promise.resolve();
let saveRevision = 0;

function getSupportedHostname(rawUrl?: string): string | null {
  if (!rawUrl) return null;

  try {
    const url = new URL(rawUrl);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.hostname.length === 0
    ) {
      return null;
    }
    return url.hostname;
  } catch {
    return null;
  }
}

async function getActiveHostname(): Promise<string | null> {
  const [activeTab] = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });
  const hostnameFromUrl = getSupportedHostname(activeTab?.url);
  if (hostnameFromUrl) return hostnameFromUrl;
  if (typeof activeTab?.id !== 'number') return null;

  try {
    const response: unknown = await browser.tabs.sendMessage(
      activeTab.id,
      { type: 'tayamun:get-hostname' },
      { frameId: 0 },
    );
    if (
      typeof response === 'object' &&
      response !== null &&
      'hostname' in response &&
      typeof response.hostname === 'string' &&
      response.hostname.length > 0
    ) {
      return response.hostname;
    }
  } catch {
    // Restricted pages have no content script to answer the request.
  }

  return null;
}

function readFormSettings(): SiteSettings {
  return {
    enabled: enabledInput.checked,
    alignRight: alignRightInput.checked,
    improveFont: improveFontInput.checked,
  };
}

function showRestricted(title: string, message: string): void {
  sitePanel.hidden = true;
  restrictedPanel.hidden = false;
  if (restrictedTitle) restrictedTitle.textContent = title;
  restrictedMessage.textContent = message;
}

function renderSettings(settings: SiteSettings): void {
  enabledInput.checked = settings.enabled;
  alignRightInput.checked = settings.alignRight;
  improveFontInput.checked = settings.improveFont;
}

function saveSettings(host: string, settings: SiteSettings): Promise<void> {
  const save = setSiteSettings(host, settings);
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error('Timed out while saving site settings.')),
      5_000,
    );
    void save.then(
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      (error: unknown) => {
        window.clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

settingsForm.addEventListener('change', (event) => {
  if (!(event.target instanceof HTMLInputElement) || !hostname) return;

  const revision = ++saveRevision;
  const settings = readFormSettings();
  saveStatus.dataset.error = 'false';
  saveStatus.textContent = 'جارٍ حفظ الإعدادات…';
  settingsForm.setAttribute('aria-busy', 'true');

  saveQueue = saveQueue
    .catch(() => undefined)
    .then(() => saveSettings(hostname as string, settings))
    .then(
      () => {
        if (revision !== saveRevision) return;
        saveStatus.textContent = 'حُفظت الإعدادات.';
        settingsForm.removeAttribute('aria-busy');
      },
      () => {
        if (revision !== saveRevision) return;
        saveStatus.dataset.error = 'true';
        saveStatus.textContent = 'تعذّر حفظ الإعدادات. حاول مرة أخرى.';
        settingsForm.removeAttribute('aria-busy');
      },
    );
});

async function initialize(): Promise<void> {
  try {
    hostname = await getActiveHostname();

    if (!hostname) {
      showRestricted(
        'لا يمكن تعديل هذه الصفحة',
        'صفحات المتصفح الداخلية وغير المدعومة لا تقبل تغييرات تَيَامُن.',
      );
      return;
    }

    const settings = await getSiteSettings(hostname);
    hostnameElement.textContent = hostname;
    hostnameElement.title = hostname;
    renderSettings(settings);
    restrictedPanel.hidden = true;
    sitePanel.hidden = false;
  } catch {
    showRestricted(
      'تعذّر تحميل الإعدادات',
      'أغلق النافذة المنبثقة ثم افتحها وحاول مرة أخرى.',
    );
  }
}

void initialize();
