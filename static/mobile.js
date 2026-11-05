/* ==========================================================================
   mobile.js —— 安卓 WebView 的触摸交互补丁（在 app.js 之后加载）
   --------------------------------------------------------------------------
   app.js 是鼠标时代写的：顶栏靠 mousemove 收起、划词靠 mouseup、
   点外部关闭靠 mousedown。这里补上触摸侧的等价逻辑，并负责：
     * 书架底栏常驻；阅读页默认纯净，点一下正文才浮出/收起底部工具栏
     * 应用内检查更新与下载安装
   ========================================================================== */
(function () {
  if (!document.documentElement.classList.contains("is-android")) return;

  const body = document.body;

  /* ---- 0. 只在安卓显示的入口 + 缩短底栏文字 ---------------------------- */
  ["btn-shelf-update", "btn-check-update"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.hidden = false;
  });
  const shelfUpdate = document.getElementById("btn-shelf-update");
  if (shelfUpdate) shelfUpdate.textContent = "更新";
  const importText = document.getElementById("btn-import-text");
  if (importText) importText.textContent = "导入";

  /* ---- 1. 阅读页工具栏：点一下正文切换显隐 ------------------------------
     书架底栏由 CSS 常驻，这里只管阅读页。 */
  function setReaderChrome(open) {
    body.classList.toggle("reader-chrome-open", open);
    if (!open) setMoreMenu(false);
  }

  // 菜单里选完一项就收起，别挡正文
  moreDropdown.addEventListener("click", () => setReaderChrome(false));
  // 返回书架 / 导入 / 打开书时都回到"纯净阅读"状态
  ["btn-back", "btn-import"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", () => setReaderChrome(false));
  });
  bookGrid.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest(".cover-wrap")) setReaderChrome(false);
  });

  /* ---- 1c. 书架：长按书封面删除（不显示垃圾桶图标） -------------------
     直接触发原本的删除按钮 → 复用同一套确认弹窗与接口，不改动业务代码。 */
  let longPressTimer = null;
  let suppressClick = false;
  const cancelLongPress = () => {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  };
  bookGrid.addEventListener("touchstart", (e) => {
    const card = e.target.closest && e.target.closest(".book-card");
    if (!card) return;
    cancelLongPress();
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      const del = card.querySelector(".book-del");
      if (del) del.click();                 // 弹出「确定删除」确认框
      if (navigator.vibrate) navigator.vibrate(30);
      // 长按结束后 WebView 还会补发一个 click，别让它顺手把书打开
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 800);
    }, 600);
  }, { passive: true });
  ["touchend", "touchcancel"].forEach((name) => {
    bookGrid.addEventListener(name, cancelLongPress, { passive: true });
  });
  bookGrid.addEventListener("touchmove", cancelLongPress, { passive: true });
  bookGrid.addEventListener("click", (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  let tapStart = null;
  document.addEventListener("touchstart", (e) => {
    const t = e.target;
    const p = e.touches && e.touches[0];
    tapStart = p ? { x: p.clientX, y: p.clientY, time: Date.now(), target: t } : null;

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

  // 短按（不是滚动、不是长按选词）才切换工具栏；点在浮层/按钮上不切换
  document.addEventListener("touchend", (e) => {
    const start = tapStart;
    tapStart = null;
    if (!start || !e.changedTouches || !e.changedTouches[0]) return;
    if (!readerView.classList.contains("active")) return;

    const p = e.changedTouches[0];
    if (Math.abs(p.clientX - start.x) > 12 || Math.abs(p.clientY - start.y) > 12) return;
    if (Date.now() - start.time > 400) return;

    const t = start.target;
    const inside = (selector) => !!(t && t.closest && t.closest(selector));
    if (inside(".reader-header") || inside(".modal") || inside("#more-dropdown") ||
        inside("#sel-toolbar") || inside("#bubble") || inside("#note-bubble") ||
        inside("#tts-bar") || inside(".back-panel")) return;

    setReaderChrome(!body.classList.contains("reader-chrome-open"));
  }, { passive: true });

  /* ---- 2. 长按选词 → 浮出操作栏 ---------------------------------------- */
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

  /* ---- 3. 长按正文时压住系统自带的复制菜单 ------------------------------ */
  readerContent.addEventListener("contextmenu", (e) => {
    const sel = window.getSelection();
    if (sel && sel.toString().trim()) e.preventDefault();
  });

  /* ---- 4. 检查更新 ------------------------------------------------------ */
  const updateModal = document.getElementById("update-modal");
  const updateTitle = document.getElementById("update-title");
  const updateDetail = document.getElementById("update-detail");
  const updateDownload = document.getElementById("update-download");

  async function checkUpdate() {
    updateModal.hidden = false;
    updateTitle.textContent = "正在检查…";
    updateDetail.textContent = "正在连接 GitHub…";
    updateDownload.hidden = true;
    try {
      const data = await api("GET", "/api/app/update");
      if (data.error) throw new Error(data.error);
      if (!data.has_update) {
        updateTitle.textContent = "已是最新版本";
        updateDetail.textContent = `当前版本：${data.local_version || data.local_built_at}`;
        return;
      }
      updateTitle.textContent = "发现新版本";
      const size = data.size_mb ? `约 ${data.size_mb} MB · ` : "";
      updateDetail.textContent =
        `当前：${data.local_version || data.local_built_at}\n最新：${data.version || data.remote_built_at}\n${size}下载完成后会自动弹出安装`;
      updateDownload.hidden = false;
      updateDownload.disabled = false;
      updateDownload.onclick = () => {
        if (!data.url) { toast("更新地址异常，请稍后再试"); return; }
        if (!window.YiduNative || !window.YiduNative.downloadUpdate) {
          toast("无法自动安装，请用浏览器打开下面的链接");
          updateDetail.textContent += "\n" + data.url;
          return;
        }
        // 防重复点击，避免连着下载好几份
        updateDownload.disabled = true;
        window.YiduNative.downloadUpdate(data.url, data.version || "");
        updateModal.hidden = true;
        toast("正在下载 " + (data.version || "新版本") + "，完成后自动弹出安装");
        setReaderChrome(false);
        setTimeout(() => { updateDownload.disabled = false; }, 3000);
      };
    } catch (err) {
      updateTitle.textContent = "检查失败";
      updateDetail.textContent = err.message || "网络不可用，稍后再试";
    }
  }

  ["btn-shelf-update", "btn-check-update"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", checkUpdate);
  });
  document.querySelectorAll("[data-update-close]").forEach((el) => {
    el.addEventListener("click", () => { updateModal.hidden = true; });
  });

  /* ---- 5. 安卓返回键：优先关浮层 / 工具栏，而不是直接退出 App ----------- */
  window.__yiduBack = function () {
    if (!updateModal.hidden) { updateModal.hidden = true; return true; }
    const openModals = document.querySelectorAll(".modal:not([hidden])");
    if (openModals.length) {
      openModals[openModals.length - 1].hidden = true;
      return true;
    }
    if (body.classList.contains("reader-chrome-open")) { setReaderChrome(false); return true; }
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

  /* ---- 6. 文案 ---------------------------------------------------------- */
  const tip = document.querySelector(".shelf-empty-tip");
  if (tip) tip.textContent = "点底部「导入」，从手机里选择一本书";
  const dropText = document.querySelector("#drop-hint .drop-hint-box");
  if (dropText) dropText.textContent = "松开手指，导入这本 EPUB";
})();
