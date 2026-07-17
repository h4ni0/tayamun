<div align="center">
  <img src="public/icon-128.png" width="96" height="96" alt="شعار تَيَامُن">

# تَيَامُن · Tayamun

**قراءة أوضح للنصوص العربية والإنجليزية المختلطة من دون إعادة كتابة محتوى الصفحة.**

[![CI](https://github.com/h4ni0/tayamun/actions/workflows/ci.yml/badge.svg)](https://github.com/h4ni0/tayamun/actions/workflows/ci.yml)
[![الترخيص: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

تَيَامُن إضافة مفتوحة المصدر بمعيار Manifest V3 لمتصفحي Chrome وFirefox. تتعرّف إلى كتل النص التي يبدأ أول حرف Unicode فيها بحرف عربي، ثم تُصلح اتجاه عرضها مع الحفاظ على النص وتخطيط الصفحة.

![نافذة تَيَامُن العربية ونص مختلط بعد تصحيح اتجاهه](store/assets/screenshot-popup-1280x800.png)

## المزايا

- تعالج النص الظاهر والمحتوى الديناميكي والحقول النصية والإطارات وShadow DOM المفتوح.
- لا تعيد كتابة النص، ولا تضيف علامات اتجاه مخفية، ولا تغيّر ترتيب عناصر التخطيط.
- تستثني الشيفرة ومحرراتها وكلمات المرور وحقول البريد الإلكتروني وعناوين المواقع والحقول غير النصية.
- تحفظ ثلاثة خيارات محلية لكل اسم مضيف دقيق: التشغيل، والمحاذاة إلى اليمين، وخط Tajawal المضمّن.
- تعيد سلوك الصفحة الأصلي عندما يتغيّر النص أو تتوقف الإضافة.
- تقسّم العمل إلى دفعات محدودة للحفاظ على استجابة الصفحات الكبيرة.

## الخصوصية والأذونات

تعمل تَيَامُن بالكامل داخل المتصفح. لا تحتوي على تحليلات أو شيفرة بعيدة، ولا تجري طلبات شبكة، ولا تجمع البيانات أو تنقلها. يُحفظ اسم المضيف وخياراته الثلاثة في التخزين المحلي للإضافة فقط.

يلزم الوصول إلى `http://*/*` و`https://*/*` لفحص النص المعروض وتطبيق إصلاحات العرض المحلية التي اختارها المستخدم. راجع [تبرير الأذونات](store/ar/permissions-and-data-declarations.md) و[سياسة الخصوصية المنشورة](https://fikhulbarmajah.com/tayamun/privacy/).

## التطوير

يتطلب Node.js 20.19 أو أحدث.

```sh
npm ci
npm run dev          # Chrome
npm run dev:firefox  # Firefox
```

## التحقق والبناء

```sh
npm run check    # TypeScript واختبارات الانحدار المركزة
npm run build    # بناء Chrome وFirefox غير المضغوط
npm run release  # التحقق وحزم المتاجر وأرشيف مصدر Firefox
```

تُنشأ النتائج داخل `.output/`، ولا يرفع المشروع أي حزمة إلى المتاجر تلقائيًا.

## بنية المشروع

- `src/core/` — اكتشاف النص واختيار الحاويات الآمنة والاستعادة ومحرك DOM المجدول.
- `src/entrypoints/` — برنامج المحتوى والنافذة المنبثقة وجسر Shadow DOM المفتوح.
- `public/` — الرسائل العربية والأيقونات وملفات Tajawal المضمّنة.
- `tests/` — اختبارات مركزة على السلامة ومشكلات الأداء السابقة.
- `store/` — بيانات المتاجر والخصوصية وملاحظات المراجعة والأصول.

## المساهمة والأمان

راجع [دليل المساهمة](CONTRIBUTING.md). أبلغ عن الثغرات بشكل خاص وفق [سياسة الأمان](SECURITY.md).

## الترخيص

شيفرة تَيَامُن وأصول المشروع الأصلية متاحة وفق [ترخيص MIT](LICENSE). ملفات خط Tajawal المضمّنة مرخّصة بشكل مستقل وفق SIL Open Font License 1.1؛ راجع [`public/fonts/OFL.txt`](public/fonts/OFL.txt) و[إشعارات الطرف الثالث](THIRD_PARTY_NOTICES.md).

---

## English

Tayamun is an open-source Manifest V3 extension for Chrome and Firefox. It detects text blocks whose first Unicode letter is Arabic and fixes their display direction while preserving the page’s text and layout.

### Features

- Processes visible text, dynamic content, text fields, frames, and open Shadow DOM.
- Never rewrites text, adds bidirectional markers, or reorders layout elements.
- Excludes code, editors, passwords, email and URL fields, and non-text inputs.
- Provides exact-host settings for enabling Tayamun, right alignment, and the bundled Tajawal font.
- Restores page-authored behavior when text changes or Tayamun is disabled.
- Uses bounded scheduled work to keep large pages responsive.

### Privacy and permissions

Tayamun works entirely inside the browser. It contains no analytics or remote code, makes no network requests, and does not collect or transmit data. Exact hostnames and their three preferences are stored only in local extension storage.

Access to `http://*/*` and `https://*/*` is required to inspect displayed text and apply the selected local presentation fixes. See the [permission rationale](store/ar/permissions-and-data-declarations.md) and [public privacy policy](https://fikhulbarmajah.com/tayamun/privacy/).

### Development

Requires Node.js 20.19 or newer.

```sh
npm ci
npm run dev          # Chrome
npm run dev:firefox  # Firefox
```

### Checks and builds

```sh
npm run check    # TypeScript + focused regression tests
npm run build    # unpacked Chrome and Firefox builds
npm run release  # checks + store ZIPs + Firefox source ZIP
```

Build output is written to `.output/`. Production packages are generated locally and are not uploaded automatically.

### Project structure

- `src/core/` — Unicode detection, safe container selection, restoration, and scheduled DOM engine.
- `src/entrypoints/` — content script, popup, and open-Shadow-DOM bridge.
- `public/` — localized messages, icons, and bundled Tajawal files.
- `tests/` — focused regressions for safety and prior performance failures.
- `store/` — store listings, privacy/reviewer notes, attribution, and upload assets.

### Contributing, security, and license

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Tayamun’s source code and original project assets use the [MIT License](LICENSE). Bundled Tajawal files use the SIL Open Font License 1.1; see [`public/fonts/OFL.txt`](public/fonts/OFL.txt) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
