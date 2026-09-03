(function () {
  try {
    var t = localStorage.getItem("luna-connect-theme");
    var isDark = false;
    if (t === "dark") isDark = true;
    else if (t === "system" || !t) {
      if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) isDark = true;
    }
    if (isDark) document.documentElement.classList.add("dark");
  } catch (e) {}
  try {
    var f = document.getElementById("favicon");
    if (f) {
      f.href = document.documentElement.classList.contains("dark")
        ? "/favicon-dark.svg"
        : "/favicon.svg";
    }
  } catch (e) {}
})();
