# Chrome Web Store listing draft

## الاسم / Title

**الدبلجة العربية المباشرة — Arabic Live Dubbing**

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

تحتاج إلى مفتاح Gemini API خاص بك. يُحفظ المفتاح محلياً على جهازك فقط، ولا يُزامن عبر Chrome Sync. ينتقل صوت التبويب مباشرةً إلى Google أثناء الجلسة. لا تحفظ الإضافة الصوت أو النصوص. أعطال مختصرة وملاحظات/إلغاء التثبيت قد تُرسل إلى موقع المطوّر audiofetcher.com بدون صوت أو مفتاح أو رابط كامل.

تخضع معالجة Google لشروط Gemini API وسياسة Google وفئة الفوترة الخاصة بمفتاحك. قد تُستخدم بيانات الفئة المجانية لتحسين منتجات Google وفق صفحة الأسعار الحالية. الفئة المجانية ليست غير محدودة، وقد تطبق Google حصصاً وحدود معدل. النموذج المستخدم معاينة وقد تتغير إتاحته.

**طريقة الاستخدام**

1. افتح تبويباً آمناً (HTTPS) يحتوي على كلام إنجليزي.
2. افتح الإضافة وأدخل مفتاح Gemini ووافق على الإفصاح.
3. اضغط «ابدأ الدبلجة» ثم افتح لوحة الترجمة الثنائية.
4. اضبط الصوتين، واضغط إيقاف عند الانتهاء.

## Full description (English fallback)

Understand English videos, courses, and webinars live in Arabic—with Arabic audio and bilingual live captions. Capture starts only after your explicit click and applies to the current audible tab. The extension sends tab audio directly to Google Gemini with your own API key; there is no developer server. Adjust original and dubbed volume independently and follow source/Arabic text in Chrome's side panel.

Your key stays in local extension storage and is never synced. The extension does not store audio or transcripts. Local aggregate usage stats show dubbing time, session count, active days, and approximate latency; they never include URLs, titles, domains, captions, or audio and can be cleared from the stats page. Nothing is sent to the developer. Google's Gemini terms, privacy policy, pricing, quotas, and preview-model availability apply. Free-tier use is not unlimited and may be used by Google to improve products under the current pricing disclosure.

## Single purpose

Translate the user-selected current tab's live spoken audio into Arabic audio and show bilingual live captions during that user-started session.

## Permission justifications

| Permission | Justification |
|---|---|
| `activeTab` | Identifies only the tab on which the user explicitly starts dubbing; avoids broad site access. |
| `tabCapture` | Captures audio only from the current tab after the user's click. No video is requested. |
| `storage` | Stores the user-provided API key locally, consent timestamp, volume preferences, and non-sensitive ephemeral session state. No sync storage. |
| `offscreen` | Runs DOM audio APIs, AudioContext/AudioWorklets, tab stream consumption, and translated audio playback while the popup is closed. |
| `sidePanel` | Displays persistent bilingual live captions and session status. |
| Host: `https://generativelanguage.googleapis.com/*` | Connects only to Google's Gemini API endpoint for the requested translation. |
| Host: `https://audiofetcher.com/*` | Sends optional crash diagnostics and opens uninstall/feedback forms. Never audio, transcripts, or the API key. |

## Data-use disclosure for the Web Store form

- **Authentication information:** User-provided Gemini API key, stored locally and sent only to Google for API authentication.
- **Website content:** Audio from the current user-selected tab and resulting transcripts, processed only for live dubbing/captions.
- **Personal communications / user-generated content:** May be incidentally present in user-selected tab audio; the extension does not inspect, retain, or send it anywhere except Google Gemini for the feature.
- **Browsing activity:** Not collected. The numeric active-tab ID exists only for lifecycle cleanup; title and full URL are not stored or transmitted.
- **Data sale/ads/credit:** None.
- **Human access:** None by the developer.
- **Retention:** No extension retention of audio/transcripts. Key/settings remain locally until deletion/uninstall.
- **Transport:** Encrypted HTTPS/WSS.

## Store assets still required before submission

- Screenshots from verified real operation (do not include keys or sensitive captions).
- Final support email/site and a publicly hosted URL for `privacy.html`.
- Final product name/publisher identity if different from the temporary values.
