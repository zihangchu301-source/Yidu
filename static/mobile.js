/* ==========================================================================
   mobile.js —— 安卓 WebView 的触摸交互补丁（在 app.js 之后加载）
   --------------------------------------------------------------------------
   app.js 是鼠标时代写的：顶栏靠 mousemove 收起、划词靠 mouseup、
   点外部关闭靠 mousedown。这里补上触摸侧的等价逻辑，并负责：
     * 底部隐藏式工具栏的唤出 / 收起
     * 应用内检查更新与下载安装
   ========================================================================== */
(function () {
  if (!document.documentElement.classList.contains("is-android")) return;

  const body = document.body;
  const handle = document.getElementById("dock-handle");

  /* ---- 0. 只在安卓显示的入口 ------------------------------------------- */
  ["btn-shelf-update", "btn-check-update"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.hidden = false;
  });
  if (handle) handle.hidden = false;

  /* ---- 1. 底部工具栏：点把手展开，点别处收起 ---------------------------- */
  function setDock(open) {
    body.classList.toggle("dock-open", open);
    if (!open) setMoreMenu(false);
  }
  if (handle) {
    handle.addEventListener("click", (e) => {
      e.stopPropagation();
      setDock(!body.classList.contains("dock-open"));
    });
  }
  // 菜单里选完一项，顺手把底栏收回去，不挡正文
  moreDropdown.addEventListener("click", () => setDock(false));
  // 打开书 / 返回书架时也收起
  ["btn-back", "btn-import"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", () => setDock(false));
  });

  /* ---- 2. 长按选词 → 浮出操作栏 ----------------------------------------
     触屏没有可靠的 mouseup 选区判断（app.js 已在该分支跳过），
     改用 selectionchange + 220ms 防抖。 */
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

  /* ---- 3. 点别处收起浮层 / 底栏 ---------------------------------------- */
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
    if (body.classList.contains("dock-open") &&
        !inside(".shelf-header") && !inside(".reader-header") &&
        !inside("#dock-handle") && !inside("#more-dropdown") &&
        !inside(".modal")) {
      setDock(false);
    }
  }, { passive: true });

  /* ---- 4. 长按正文时压住系统自带的复制菜单 ------------------------------ */
  readerContent.addEventListener("contextmenu", (e) => {
    const sel = window.getSelection();
    if (sel && sel.toString().trim()) e.preventDefault();
  });

  /* ---- 5. 检查更新 ------------------------------------------------------ */
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
        updateDetail.textContent = `当前构建：${data.local_built_at}`;
        return;
      }
      updateTitle.textContent = "发现新版本";
      const size = data.size_mb ? `约 ${data.size_mb} MB · ` : "";
      updateDetail.textContent =
        `当前：${data.local_built_at}\n最新：${data.remote_built_at}\n${size}下载完成后会自动弹出安装`;
      updateDownload.hidden = false;
      updateDownload.onclick = () => {
        if (window.YiduNative && window.YiduNative.downloadUpdate) {
          window.YiduNative.downloadUpdate(data.url);
          updateModal.hidden = true;
          toast("正在下载更新，完成后会弹出安装");
        } else {
          window.open(data.url, "_blank");
        }
        setDock(false);
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
    el.addEventListener("click", () => { updateModal.hidden = true; setDock(false); });
  });

  /* ---- 6. 安卓返回键：优先关浮层 / 底栏，而不是直接退出 App ------------- */
  window.__yiduBack = function () {
    if (!updateModal.hidden) { updateModal.hidden = true; return true; }
    const openModals = document.querySelectorAll(".modal:not([hidden])");
    if (openModals.length) {
      openModals[openModals.length - 1].hidden = true;
      return true;
    }
    if (body.classList.contains("dock-open")) { setDock(false); return true; }
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

  /* ---- 7. 文案：手机上没有拖拽这回事 ------------------------------------ */
  const tip = document.querySelector(".shelf-empty-tip");
  if (tip) tip.textContent = "点底部小横条展开工具栏，再点「导入 EPUB」";
  const dropText = document.querySelector("#drop-hint .drop-hint-box");
  if (dropText) dropText.textContent = "松开手指，导入这本 EPUB";
})();
