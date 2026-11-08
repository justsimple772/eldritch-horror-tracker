// Keep the display awake only while this app is visible. Browsers release the
// lock in the background, so acquire a new one when the user returns.
(() => {
  if (!navigator.wakeLock) return;
  let lock = null;
  let pending = false;

  async function keepScreenAwake() {
    if (document.visibilityState !== "visible" || lock || pending) return;
    pending = true;
    try {
      const acquired = await navigator.wakeLock.request("screen");
      lock = acquired;
      acquired.addEventListener("release", () => {
        if (lock === acquired) lock = null;
      });
      // The app may have been hidden while the request was in flight.
      if (document.visibilityState !== "visible") await acquired.release();
    } catch (_) {
      // Unsupported policy / power-saving mode must not interrupt the game.
    } finally {
      pending = false;
    }
  }

  document.addEventListener("visibilitychange", keepScreenAwake);
  window.addEventListener("pageshow", keepScreenAwake);
  // Retry after a user gesture if the browser declined the initial request.
  document.addEventListener("pointerdown", keepScreenAwake, { passive: true });
  document.addEventListener("keydown", keepScreenAwake);
  keepScreenAwake();
})();
