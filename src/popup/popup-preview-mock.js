// Browser-preview stub for popup.html — mirrors ../library/preview-mock.js.
// External file (never inline) so extension-page CSP/static checks stay clean.
window.chrome = window.chrome || {};
window.chrome.tabs = window.chrome.tabs || {};
window.chrome.tabs.query = () =>
  Promise.resolve([{ id: 1, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }]);
