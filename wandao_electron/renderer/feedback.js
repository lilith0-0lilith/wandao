(function (root) {
  let activeConfirmation = null;
  let notificationSequence = 0;

  function getDocument() {
    return root.document || null;
  }

  function ensureLayer() {
    const document = getDocument();
    if (!document?.body) return null;
    let layer = document.getElementById('feedback-layer');
    if (layer) return layer;
    layer = document.createElement('div');
    layer.id = 'feedback-layer';
    layer.className = 'feedback-layer';
    layer.setAttribute('aria-label', '应用反馈');
    document.body.appendChild(layer);
    return layer;
  }

  function ensureToastRegion() {
    const layer = ensureLayer();
    if (!layer) return null;
    let region = layer.querySelector('.feedback-toast-region');
    if (!region) {
      region = document.createElement('div');
      region.className = 'feedback-toast-region';
      region.setAttribute('aria-live', 'polite');
      region.setAttribute('aria-atomic', 'false');
      layer.appendChild(region);
    }
    return region;
  }

  function appendText(parent, value, className = '') {
    const node = document.createElement('div');
    if (className) node.className = className;
    node.textContent = String(value || '');
    parent.appendChild(node);
    return node;
  }

  function removeLater(node, duration) {
    if (!node || !duration) return null;
    return root.setTimeout(() => {
      node.classList.add('is-leaving');
      root.setTimeout(() => node.remove(), 180);
    }, duration);
  }

  function notify(message, options = {}) {
    const region = ensureToastRegion();
    if (!region) return { id: '', dismiss() {} };
    const type = ['success', 'warn', 'error', 'info'].includes(options.type) ? options.type : 'info';
    const node = document.createElement('article');
    const id = `feedback-${++notificationSequence}`;
    node.id = id;
    node.className = `feedback-toast ${type}`;
    node.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const content = document.createElement('div');
    content.className = 'feedback-toast-content';
    if (options.title) appendText(content, options.title, 'feedback-toast-title');
    appendText(content, message, 'feedback-toast-message');
    if (options.recovery) appendText(content, options.recovery, 'feedback-toast-recovery');
    node.appendChild(content);
    if (typeof options.action === 'function') {
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'feedback-toast-action';
      action.textContent = options.actionLabel || '处理';
      action.addEventListener('click', () => options.action());
      node.appendChild(action);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'feedback-toast-close';
    close.setAttribute('aria-label', '关闭提示');
    close.textContent = '×';
    close.addEventListener('click', () => node.remove());
    node.appendChild(close);
    region.appendChild(node);
    const timeout = options.duration === 0 ? null : removeLater(node, Number(options.duration) || 5200);
    return {
      id,
      dismiss() {
        if (timeout) root.clearTimeout(timeout);
        node.remove();
      }
    };
  }

  function error(error, options = {}) {
    const protocol = root.WandaoErrorProtocol?.normalizeError;
    const info = typeof protocol === 'function' ? protocol(error, options) : {
      userMessage: String(error?.message || error || '任务执行失败'),
      recovery: ''
    };
    const toast = notify(options.message || info.userMessage, {
      ...options,
      type: options.type || 'error',
      title: options.title || info.categoryLabel
        || root.WandaoErrorProtocol?.categoryLabel?.(info.category)
        || info.category
        || '操作失败',
      recovery: options.recovery || info.recovery
    });
    if (options.showDetails !== false && info.technicalMessage && info.technicalMessage !== info.userMessage) {
      const node = getDocument()?.getElementById(toast.id);
      if (node) {
        const details = document.createElement('details');
        details.className = 'feedback-toast-details';
        const summary = document.createElement('summary');
        summary.textContent = '查看技术摘要';
        const pre = document.createElement('pre');
        pre.textContent = info.technicalMessage;
        details.append(summary, pre);
        node.querySelector('.feedback-toast-content')?.appendChild(details);
      }
    }
    return toast;
  }

  function finishConfirmation(value) {
    if (!activeConfirmation) return;
    const current = activeConfirmation;
    activeConfirmation = null;
    root.removeEventListener?.('keydown', current.onKeyDown, true);
    current.node.remove();
    if (current.returnFocus?.isConnected) current.returnFocus.focus?.({ preventScroll: true });
    current.resolve(Boolean(value));
  }

  function confirmAction(message, options = {}) {
    const document = getDocument();
    if (!document?.body) return Promise.resolve(true);
    if (activeConfirmation) finishConfirmation(false);
    const layer = ensureLayer();
    const HTMLElementCtor = root.HTMLElement;
    const returnFocus = HTMLElementCtor && document.activeElement instanceof HTMLElementCtor
      ? document.activeElement
      : null;
    const node = document.createElement('div');
    node.className = 'feedback-dialog-backdrop';
    node.setAttribute('role', 'presentation');
    const dialog = document.createElement('section');
    const dialogId = `feedback-dialog-${++notificationSequence}`;
    dialog.id = dialogId;
    dialog.className = `feedback-dialog ${options.danger ? 'danger' : ''}`;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', `${dialogId}-title`);
    dialog.setAttribute('aria-describedby', `${dialogId}-message`);
    const title = document.createElement('h2');
    title.id = `${dialogId}-title`;
    title.textContent = options.title || '请确认操作';
    const body = document.createElement('p');
    body.id = `${dialogId}-message`;
    body.className = 'feedback-dialog-message';
    body.textContent = String(message || '确认继续吗？');
    const actions = document.createElement('div');
    actions.className = 'feedback-dialog-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-secondary';
    cancel.textContent = options.cancelLabel || '取消';
    cancel.addEventListener('click', () => finishConfirmation(false));
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = options.danger ? 'btn-danger' : 'btn-primary';
    confirm.textContent = options.confirmLabel || '继续';
    confirm.addEventListener('click', () => finishConfirmation(true));
    actions.append(cancel, confirm);
    dialog.append(title, body, actions);
    node.appendChild(dialog);
    node.addEventListener('click', (event) => {
      if (event.target === node && options.dismissOnBackdrop !== false) finishConfirmation(false);
    });
    layer.appendChild(node);
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finishConfirmation(false);
      } else if (event.key === 'Tab') {
        const focusables = [cancel, confirm].filter((button) => !button.disabled);
        if (!focusables.length) return;
        const index = focusables.indexOf(document.activeElement);
        const next = event.shiftKey
          ? focusables[(index - 1 + focusables.length) % focusables.length]
          : focusables[(index + 1) % focusables.length];
        event.preventDefault();
        next.focus();
      }
    };
    return new Promise((resolve) => {
      activeConfirmation = { node, resolve, onKeyDown, returnFocus };
      root.addEventListener?.('keydown', onKeyDown, true);
      if (typeof root.requestAnimationFrame === 'function') {
        root.requestAnimationFrame(() => confirm.focus());
      } else {
        confirm.focus();
      }
    });
  }

  const api = Object.freeze({ ensureLayer, notify, error, confirm: confirmAction });
  root.WandaoFeedback = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
