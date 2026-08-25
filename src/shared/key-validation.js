// Local validation only. The key panel displays a concise, non-blocking
// disclosure explaining that starting dubbing sends tab audio/transcripts
// directly to Google Gemini; saving a key itself does not transmit audio.

export function validateApiKey(apiKey) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (key.length < 20 || key.length > 256) {
    return { ok: false, error: 'صيغة مفتاح Gemini غير صالحة.' };
  }
  return { ok: true, apiKey: key };
}
