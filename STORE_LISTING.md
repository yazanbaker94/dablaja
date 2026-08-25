# Chrome Web Store listing draft

## الاسم / Title

**الدبلجة العربية المباشرة — dablaja**

## الوصف المختصر (Arabic-first)

افهم الفيديوهات الإنجليزية مباشرةً بالعربية، بصوت عربي وترجمة ثنائية مباشرة.

## Short description (English fallback)

Understand English videos live in Arabic with dubbed audio and bilingual captions.

## الوصف الكامل بالعربية

شاهد الفيديوهات والدورات والندوات الإنجليزية وافهمها مباشرةً بالعربية. تبدأ الإضافة فقط عندما تضغط زر البدء في تبويب مسموع، ثم ترسل صوته مباشرةً إلى Google Gemini باستخدام مفتاح API الخاص بك.

**ما الذي يقدمه الإصدار الأول؟**

- دبلجة صوتية عربية مباشرة للفيديوهات والمحتوى المسموع باللغة الإنجليزية.
- ترجمة ثنائية مباشرة: النص الأصلي والترجمة العربية في لوحة جانبية ثابتة.
- تحكم مستقل في مستوى الصوت الأصلي ومستوى صوت الدبلجة.
- يعمل مع التبويبات المسموعة العادية، وليس مخصصاً لموقع واحد.
- حالات واضحة للاتصال والاستماع والترجمة وإعادة الاتصال والأخطاء.
- زر إيقاف يغلق الالتقاط والاتصال ومعالجة الصوت ويعيد صوت التبويب إلى وضعه الطبيعي.

**مفتاحك وخصوصيتك**

تحتاج إلى مفتاح Gemini API خاص بك. تعرض الإضافة بجانب حقل المفتاح إفصاحاً واضحاً بأن بدء الدبلجة يرسل صوت التبويب ونصوصه إلى Google أثناء الجلسة؛ حفظ المفتاح وحده لا يبدأ الإرسال. يُحفظ المفتاح محلياً على جهازك فقط، ولا يُزامن عبر Chrome Sync. لا يُحفظ الصوت مطلقاً، ولا تُرفع بيانات الجلسات إلى الخادم. الحفظ المحلي مفعّل افتراضياً ويمكن تعطيله؛ تتيح النسخة المجانية جلسة واحدة وعلامة واحدة وملف موقع واحد، بينما تتيح Plus حتى 500 جلسة و100 علامة لكل جلسة و50 ملف موقع. بعد تفعيل المستخدم خيار المشاركة المنفصل فقط، قد تُرسل مدة الدبلجة وفئة الموقع ومخطط تشخيصي مقيد للأعطال إلى audiofetcher.com؛ لا صوت ولا نصوص ولا مفتاح ولا روابط أو عناوين، ولا معرف التثبيت المستخدم للترخيص. إيقاف المشاركة لا يؤثر في الدبلجة.

تخضع معالجة Google لشروط Gemini API وسياسة Google وفئة الفوترة الخاصة بمفتاحك. قد تُستخدم بيانات الفئة المجانية لتحسين منتجات Google وفق صفحة الأسعار الحالية. الفئة المجانية ليست غير محدودة، وقد تطبق Google حصصاً وحدود معدل. النموذج المستخدم معاينة وقد تتغير إتاحته.

**طريقة الاستخدام**

1. افتح تبويباً آمناً (HTTPS) يحتوي على كلام إنجليزي.
2. افتح الإضافة وأدخل مفتاح Gemini ووافق على الإفصاح.
3. اضغط «ابدأ الدبلجة» ثم افتح لوحة الترجمة الثنائية.
4. اضبط الصوتين، واضغط إيقاف عند الانتهاء.

## Full description (English fallback)

Understand English videos, courses, and webinars live in Arabic—with Arabic audio and bilingual live captions. Capture starts only after your explicit click and applies to the current audible tab. The extension sends tab audio directly to Google Gemini with your own API key; audio and transcripts never pass through the developer server. Adjust original and dubbed volume independently and follow source/Arabic text in Chrome's side panel.

Beside the key field, the extension shows an in-product disclosure that starting dubbing sends tab audio and transcripts to Google for that session; saving the key alone sends no audio. Your key stays in local extension storage and is never synced. Audio is never stored. Saved transcripts, titles, and URLs remain strictly local on your device. Local saving is enabled by default and can be disabled; Free supports 1 session, 1 bookmark, and 1 site profile, while Plus supports up to 500 sessions, 100 bookmarks per session, and 50 site profiles. Only after the user separately enables anonymous sharing are dubbed duration, a coarse platform category, and allowlisted technical error diagnostics sent to AudioFetcher; never URLs, titles, audio, transcripts, keys, or the stable licensing installation ID. Disabling sharing does not affect dubbing. Google's Gemini terms, privacy policy, pricing, quotas, and preview-model availability apply.

## Single purpose

Translate the user-selected current tab's live spoken audio into Arabic audio and show bilingual live captions during that user-started session.

## Permission justifications

| Permission | Justification |
|---|---|
| `activeTab` | Identifies only the tab on which the user explicitly starts dubbing; avoids broad site access. |
| `tabCapture` | Captures audio only from the current tab after the user's click. No video is requested. |
| `storage` | Stores the user-provided API key, volume/settings choices, local statistics, licensing state, and bounded local drafts/saved sessions. No sync storage. |
| `offscreen` | Runs DOM audio APIs, AudioContext/AudioWorklets, tab stream consumption, and translated audio playback while the popup is closed. |
| `sidePanel` | Displays persistent bilingual live captions and session status. |
| Host: `https://generativelanguage.googleapis.com/*` | Connects only to Google's Gemini API endpoint for the requested translation. |
| Host: `https://audiofetcher.com/*` | With the separate optional sharing toggle enabled, sends aggregate dubbed duration, coarse platform category, and allowlisted crash diagnostics; also handles Plus licensing/checkout and opens user-submitted uninstall/feedback forms. Never audio, transcripts, URLs, titles, or the API key. |

## Data-use disclosure for the Web Store form

- **Authentication information:** User-provided Gemini API key, stored locally and sent only to Google for API authentication.
- **Website content:** Audio from the current user-selected tab and resulting transcripts, processed only for live dubbing/captions. Audio is never stored.
- **Personal communications / user-generated content:** May be incidentally present in user-selected tab audio; the extension does not inspect, retain, or send it anywhere except Google Gemini for the feature.
- **Browsing activity:** With separate opt-in consent, a coarse category (`YouTube`, `X`, `Twitch`, or `other`) is transmitted after a session for aggregate statistics. Browsing history is never stored or transmitted. A page URL/title is stored only locally inside an explicitly saved session in IndexedDB on the user's device.
- **Data sale/ads/credit:** None.
- **Licensing & Payment Data:** Payment cards are processed directly by Stripe; Dablaja never receives or stores card numbers. AudioFetcher retains only random installation identifier (`install_id`), hashed installation credential (`credential_hash`), stable internal license identifier (`license_id`), Stripe reference identifiers, product/price IDs, amount/currency/status, bindings, timestamps, revocation state, and hashed recovery code (`code_hash`).
- **Human access:** Authorized support may view opt-in technical diagnostics and forms to fix failures or respond to feedback; no audio, transcripts, key, URL, or title is available.
- **Retention:** No extension retention of audio. Key/settings/saved sessions remain locally until deletion/uninstall. One-time usage event IDs are removed within 8 days; diagnostics within 45 days; submitted forms within 180 days; unpaid/failed Checkout attempts within 30 days; daily anonymous aggregates may be retained for historical totals. Completed purchase/license records remain while the license exists and as needed for accounting, fraud prevention, refunds/disputes, support, and legal obligations.
- **Transport:** Encrypted HTTPS/WSS.

## Store assets still required before submission

- Screenshots from verified real operation (do not include keys or sensitive captions).
- Final support email/site and a publicly hosted URL for `privacy.html`.
- Final product name/publisher identity if different from the temporary values.

**Dablaja Plus — ترخيص مدى الحياة بدفعة واحدة 10$**

مكتبة جلسات محلية على جهازك فقط: حفظ حتى 500 جلسة مع النص الأصلي والترجمة العربية، حتى 100 علامة لكل جلسة، وحتى 50 ملف موقع لتذكر مستويات الصوت، مع بحث وتصدير (نص/SRT/JSON/طباعة) ونسخة احتياطية كاملة. الصوت لا يُحفظ أبداً ولا تُرسل أي بيانات جلسة إلى الخادم. الشراء عبر Stripe Checkout، الترخيص مرتبط بهذا التثبيت ويُستعاد عبر رمز استرداد يُعرض مرة واحدة بعد الدفع. الاسترداد/النزاع يُلغي الترخيص. الترخيص صالح 30 يوماً مع مهلة 7 أيام بدون اتصال وتجديد دوري.
