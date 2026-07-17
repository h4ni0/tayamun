# تجهيز الإصدار ورفعه

## التحقق والبناء

1. ثبّت الاعتماديات من ملف القفل: `npm ci`.
2. شغّل التحقق الكامل: `npm run check`.
3. أنشئ حزمتَي الرفع وأرشيف مصدر Firefox: `npm run zip`.
4. افحص أن `manifest.json` في جذر كل ZIP.
5. افحص وجود ملفات Tajawal الستة و`fonts/OFL.txt` في الحزمتين.
6. افحص أن حزمة Firefox تحتوي على معرّف Gecko ثابت وتصريح جمع البيانات `none`.

## Chrome Web Store

- ارفع حزمة Chrome الناتجة من WXT.
- الصق المحتوى من `store/ar/chrome-listing.md`.
- ارفع الأصول المحددة في `store/ASSETS.md`.
- الصق التبريرات من `store/ar/permissions-and-data-declarations.md`.
- اختر عدم استخدام شيفرة بعيدة وعدم جمع بيانات.
- أدخل رابط النسخة المنشورة من `store/ar/privacy-policy.md`.

## Firefox Add-ons

- ارفع حزمة Firefox غير الموقعة؛ يتولى AMO التوقيع.
- أرفق أرشيف المصدر الناتج من `wxt zip -b firefox --sources` للإصدار نفسه.
- الصق المحتوى من `store/ar/firefox-listing.md` وملاحظات المراجعة.
- ارفع أيقونتَي 32 و64 بكسل ولقطة الشاشة.
- صرّح بأن الإضافة لا تجمع بيانات ولا تنقلها.

## الروابط العامة

- سياسة الخصوصية: https://fikhulbarmajah.com/tayamun/privacy/
- المصدر المفتوح: https://github.com/h4ni0/tayamun

## مدخلات خارجية لازمة قبل النشر

- حسابا ناشر موثقان في Chrome Web Store وFirefox Add-ons وهوية الناشر المعروضة.
- روابط دعم أو صفحة رئيسية إذا أراد الناشر عرضها في المتجرين.

لا تحتاج عملية بناء حزم الرفع إلى مفاتيح توقيع أو أسرار متجرية.
