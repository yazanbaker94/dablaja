# Privacy — dablaja

dablaja has **no server**. The extension talks only to Google's Gemini API (to translate) and, when you open the library, to YouTube's thumbnail host. The developer receives nothing.

## What happens to your data

| Data | Where it goes | Where it's kept |
| --- | --- | --- |
| Gemini API key | Sent to Google with each Gemini request | `chrome.storage.local` on this device only (never synced) |
| Tab audio | Streamed to Google Gemini during a session you start | Never stored |
| Transcripts (source and Arabic) | Returned by Google Gemini | In memory during the session; saved to local IndexedDB only while local saving is on |
| Session title, page URL, site name | Nowhere | Local IndexedDB with the saved session |
| Notes, bookmarks, site volume profiles | Nowhere | This device |
| Usage statistics (durations, site names, latency) | Nowhere | `chrome.storage.local` on this device |
| YouTube video ID of a saved session | `i.ytimg.com`, to load its thumbnail when the library opens (sent with no referrer) | — |

- **Google Gemini** processes audio and text under the [Gemini API terms](https://ai.google.dev/gemini-api/terms) and the data-use rules of the billing tier attached to **your** key. On the free tier, Google may use content to improve its products. See Google's [data-use guidance](https://ai.google.dev/gemini-api/docs/zdr).
- The extension does not configure Gemini session resumption, so Google is not asked to keep conversation state between reconnects.
- **YouTube thumbnails:** Google/YouTube receives the video ID and ordinary network metadata such as your IP address. Non-YouTube sessions use a bundled image.
- No analytics, telemetry, ads, tracking, content scripts or browsing-history access.

## Your controls

- Turn **local saving** off in the library settings. Live dubbing keeps working, and no transcripts are stored.
- Delete individual sessions, bookmarks and site profiles, or clear the whole library, from the library page.
- Clear usage statistics from the stats page.
- Delete the API key from the popup.
- Uninstalling the extension removes all of its local data.

---

## الخصوصية — ملخص بالعربية

لا تملك dablaja أي خادم. يُرسل صوت التبويب ونصوصه مباشرةً إلى Google Gemini فقط أثناء جلسة تبدؤها أنت، وباستخدام مفتاحك الخاص. لا يُخزَّن الصوت مطلقاً. يُحفظ المفتاح والنصوص والملاحظات والإحصائيات محلياً على جهازك فقط، ولا يصل أي منها إلى المطوّر. عند فتح المكتبة قد تُطلب صورة مصغّرة لفيديو YouTube محفوظ من `i.ytimg.com` دون مُحيل. يمكنك تعطيل الحفظ المحلي أو حذف أي بيانات من صفحة المكتبة، ويؤدي إلغاء تثبيت الإضافة إلى حذف كل بياناتها المحلية.
