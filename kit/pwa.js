(function () {
  if (!("serviceWorker" in navigator)) return;
  var secure = location.protocol === "https:" || /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  if (!secure) return;

  window.addEventListener("load", function () {
    try {
      navigator.serviceWorker.register(new URL("../sw.js", location.href)).catch(function () {});
    } catch (error) {}
  });

  var deferred = null;
  function button() {
    if (!deferred || document.getElementById("pwaInstall")) return;
    var el = document.createElement("button");
    el.id = "pwaInstall";
    el.type = "button";
    el.textContent = "Установить приложение";
    el.addEventListener("click", function () {
      if (!deferred) return;
      deferred.prompt();
      deferred.userChoice.then(function () {
        deferred = null;
        el.remove();
      });
    });
    document.body.appendChild(el);
  }

  window.addEventListener("beforeinstallprompt", function (event) {
    event.preventDefault();
    deferred = event;
    if (document.body) button();
    else document.addEventListener("DOMContentLoaded", button, { once: true });
  });

  window.addEventListener("appinstalled", function () {
    deferred = null;
    var el = document.getElementById("pwaInstall");
    if (el) el.remove();
  });
})();
