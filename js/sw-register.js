/* sw-register.js — enregistre le service worker (PWA).
 * Actif uniquement en http(s) : automatiquement ignoré en file:// et dans
 * l'artefact (qui n'autorise pas les service workers). Ce fichier n'est PAS
 * inclus dans le bundle autonome (build_bundle.py retire les <script src>). */
(function () {
  "use strict";
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol !== "http:" && location.protocol !== "https:") return;
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("service-worker.js").catch(function () { /* silencieux */ });
  });
})();
