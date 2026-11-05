/* ==========================================================================
   mobile.js —— 安卓 WebView 的触摸交互补丁（在 app.js 之后加载）
   --------------------------------------------------------------------------
   app.js 里所有交互都是鼠标时代写的：顶栏靠 mousemove 收起、划词靠 mouseup、
   点外部关闭靠 mousedown。触屏上这些事件要么不发，要么是"合成"的，
   顺序还和鼠标不一样。这里补上触摸侧的等价逻辑。

   依赖 app.js 暴露的全局函数：showSelToolbar / hideSelToolbar /
   isSelectionInsideContent / hideBubble / hideNoteBubble / setMoreMenu 等。
   ========================================================================== */
(function () {
  if (!document.documentElement.classList.contains("is-android")) return;

  /* ---- 1. 长按选词 → 浮出操作栏 ----------------------------------------
     触屏没有可靠的 mouseup 选区判断（app.js 已在该分支跳过），
     改为监听 selectionchange：用户拖动手柄改选区时会连续触发，
     用 220ms 防抖，等选区稳定再浮出，避免操作栏跟着抖。 */
  let selTimer = null;
  document.addEventListener("selectionchange", () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      if (!readerView.classList.contains("active")) return;
      if (document.querySelector(".modal:not([hidden])")) return;
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : "";
      if (!text || !isSelectionInsideContent(sel)) return;
      showSelToolbar(sel);
    }, 220);
  });

  /* ---- 2. 点别处收起浮层 ------------------------------------------------
     WebView 通常会合成 mousedown，但长按选词 / 快速滑动时不一定。
     用 touchstart 兜底，保证气泡、工具栏、菜单、抽屉都能点外部关掉。 */
  document.addEventListener("touchstart", (e) => {
    const t = e.target;
    const inside = (selector) => !!(t && t.closest && t.closest(selector));

    if (!inside("#bubble")) hideBubble();
    if (!inside("#sel-toolbar")) hideSelToolbar();
    if (!inside("#note-bubble")) hideNoteBubble();
    if (!moreDropdown.hidden && !inside("#more-dropdown") && !inside("#btn-more")) {
      setMoreMenu(false);
    }
    const floating = t && t.closest ? t.closest(".modal.panel-float") : null;
    if (floating && !inside(".notes-box") && !inside(".modal-box")) {
      floating.hidden = true;
    }
  }, { passive: true });

  /* ---- 3. 长按正文时压住系统自带的"复制/全选"菜单 -----------------------
     它会盖住我们自己的操作栏；用户仍能用操作栏里的「复制」。 */
  readerContent.addEventListener("contextmenu", (e) => {
    const sel = window.getSelection();
    if (sel && sel.toString().trim()) e.preventDefault();
  });

  /* ---- 4. 安卓返回键：优先关浮层，而不是直接退出 App -------------------
     MainActivity.onBackPressed 会调用 window.__yiduBack()。 */
  window.__yiduBack = function () {
    const openModals = document.querySelectorAll(".modal:not([hidden])");
    if (openModals.length) {
      openModals[openModals.length - 1].hidden = true;
      return true;
    }
    if (!moreDropdown.hidden) { setMoreMenu(false); return true; }
    if (!bubble.hidden) { hideBubble(); return true; }
    if (!noteBubble.hidden) { hideNoteBubble(); return true; }
    if (!selToolbar.hidden) { hideSelToolbar(); return true; }
    if (readerView.classList.contains("active")) {
      const backBtn = document.getElementById("btn-back");
      if (backBtn) { backBtn.click(); return true; }
    }
    return false;
  };

  /* ---- 5. 文案：手机上没有"拖拽"这回事 --------------------------------- */
  const tip = document.querySelector(".shelf-empty-tip");
  if (tip) tip.textContent = "点右上角「导入 EPUB」，从手机里选择一本书";
  const dropText = document.querySelector("#drop-hint .drop-hint-box");
  if (dropText) dropText.textContent = "松开手指，导入这本 EPUB";
})();
