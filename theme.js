// Applies the saved theme before first paint (separate file because the CSP blocks inline scripts).
(function () {
  var t = "system";
  try { t = (JSON.parse(localStorage.getItem("settings") || "{}") || {}).theme || "system"; } catch (e) {}
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
})();
