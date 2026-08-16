// Explicit Gemini processing consent — required before a NEW key is saved.
// Viewing an already-saved masked key must not re-require the checkbox.

export const GEMINI_CONSENT_TEXT_AR = 'أوافق على إرسال صوت التبويب والنصوص المؤقتة مباشرةً إلى Google Gemini لإنتاج الدبلجة والترجمة. لا تحفظ دبلجة الصوت أو النصوص إلا إذا اخترت حفظ جلسة في Plus.';
export const GEMINI_CONSENT_TEXT_EN = 'I agree to send the current tab audio and temporary transcripts directly to Google Gemini to produce the dubbing and translation. Neither the dubbed audio nor the transcripts are stored unless you choose to save a session in Plus.';

export function validateKeySave({ apiKey, consent } = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (key.length < 20 || key.length > 256) {
    return { ok: false, error: 'صيغة مفتاح Gemini غير صالحة.' };
  }
  if (consent !== true) {
    return { ok: false, error: 'يجب الموافقة على إرسال صوت التبويب إلى Google قبل حفظ المفتاح.' };
  }
  return { ok: true, apiKey: key };
}

// The checkbox is only meaningful when entering a new key. A saved key that is
// merely displayed masked does not re-trigger the consent requirement.
export function requiresFreshConsent({ keyEdited = false, hasSavedKey = false } = {}) {
  return keyEdited === true || hasSavedKey !== true;
}
