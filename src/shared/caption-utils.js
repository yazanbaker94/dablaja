export function mergeCaptionText(previous, incoming) {
  const prior = String(previous || '').trim();
  const next = String(incoming || '').trim();
  if (!next) return prior;
  if (!prior || next.startsWith(prior)) return next;
  if (prior.startsWith(next) || prior.endsWith(next)) return prior;
  const separator = /\s$/.test(prior) ? '' : ' ';
  return `${prior}${separator}${next}`;
}

export function shouldFinalizeCaption(text, explicitFinished = false) {
  return explicitFinished || /[.!?؟]$/.test(String(text || '').trim());
}
