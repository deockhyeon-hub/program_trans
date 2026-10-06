// 화면 테마·글자 크기를 첫 화면이 그려지기 전에 적용한다 (깜빡임 방지).
// CSP 때문에 인라인 스크립트를 못 써서 작은 파일로 뺐다. <head>에서 동기로 불린다.
(function () {
  try {
    var s = JSON.parse(localStorage.getItem("biztr.settings.v1") || "{}");
    var root = document.documentElement;
    if (s.theme === "light" || s.theme === "dark") root.setAttribute("data-theme", s.theme);
    if (s.textSize === "l" || s.textSize === "xl") root.setAttribute("data-size", "l");
  } catch (e) {
    /* 설정을 못 읽어도 기본 화면으로 뜬다 */
  }
})();
