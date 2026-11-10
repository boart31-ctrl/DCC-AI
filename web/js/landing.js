// Landing page: register the service worker (kept out of the HTML for the Content-Security-Policy).
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
