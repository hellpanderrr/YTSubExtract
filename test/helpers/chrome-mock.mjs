// Minimal chrome.* mock for unit-testing the background SW in plain Node.
// Supports exactly the overload shapes src/background uses:
//   - chrome.tabs.query(query, cb)          (callback)
//   - chrome.tabs.get(id, cb) / get(id)     (callback AND promise)
//   - chrome.tabs.update(id, {url})         (promise)
//   - chrome.storage.local.get/set/remove   (promise)
//   - chrome.downloads.download             (promise)
//   - chrome.runtime.onMessage.addListener  (captured for send())
// runtime.lastError is only set during a failing callback, like real Chrome.

function urlMatches(pattern, url) {
  if (!url) return false;
  if (pattern.includes('youtube.com')) {
    return /https?:\/\/([^/]+\.)?youtube\.com\//.test(url);
  }
  return true;
}

export function installChrome() {
  const state = {
    storageData: new Map(),
    tabs: [],
    listeners: [],
    downloads: [],
    tabUpdates: [],
    sentMessages: [],
    downloadMode: 'ok', // 'ok' | 'fail'
  };

  const chrome = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(fn) {
          state.listeners.push(fn);
        },
      },
      sendMessage: async () => ({ success: true }),
    },
    storage: {
      local: {
        async get(keys) {
          if (keys == null) return Object.fromEntries(state.storageData);
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) {
            if (state.storageData.has(k)) out[k] = state.storageData.get(k);
          }
          return out;
        },
        async set(items) {
          for (const [k, v] of Object.entries(items)) state.storageData.set(k, v);
        },
        async remove(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) state.storageData.delete(k);
        },
      },
    },
    tabs: {
      onUpdated: { addListener() {}, removeListener() {} },
      query(query, cb) {
        let tabs = state.tabs.slice();
        if (query && query.url) {
          const patterns = Array.isArray(query.url) ? query.url : [query.url];
          tabs = tabs.filter((t) => patterns.some((p) => urlMatches(p, t.url)));
        }
        if (query && query.active !== undefined) {
          tabs = tabs.filter((t) => t.active === query.active);
        }
        if (typeof cb === 'function') {
          cb(tabs);
          return;
        }
        return Promise.resolve(tabs);
      },
      get(id, cb) {
        const tab = state.tabs.find((t) => t.id === id);
        if (typeof cb === 'function') {
          if (tab) {
            cb(tab);
          } else {
            chrome.runtime.lastError = { message: `No tab with id: ${id}.` };
            cb(undefined);
            chrome.runtime.lastError = null;
          }
          return;
        }
        return tab
          ? Promise.resolve(tab)
          : Promise.reject(new Error(`No tab with id: ${id}.`));
      },
      async update(id, details) {
        const tab = state.tabs.find((t) => t.id === id);
        state.tabUpdates.push({ id, ...details });
        if (tab && details && details.url) tab.url = details.url;
        return tab || null;
      },
      sendMessage(tabId, message, cb) {
        state.sentMessages.push({ tabId, message });
        const response = { success: false, error: 'sendMessage not stubbed' };
        if (typeof cb === 'function') {
          cb(response);
          return;
        }
        return Promise.resolve(response);
      },
    },
    downloads: {
      async download(opts) {
        if (state.downloadMode === 'fail') {
          throw new Error('downloads unavailable (mock)');
        }
        state.downloads.push(opts);
        return state.downloads.length;
      },
    },
    scripting: {
      async executeScript() {
        return [{ result: null }];
      },
    },
  };

  globalThis.chrome = chrome;

  /** Deliver a message to the captured onMessage listener(s) like Chrome would. */
  function send(request, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`sendResponse timeout for ${request.type}`)),
        timeoutMs
      );
      const sendResponse = (resp) => {
        clearTimeout(timer);
        resolve(resp);
      };
      let keepAsync = false;
      for (const fn of state.listeners) {
        const keep = fn(request, {}, sendResponse);
        if (keep === true) keepAsync = true;
      }
      if (!keepAsync && state.listeners.length === 0) {
        clearTimeout(timer);
        reject(new Error('no onMessage listener registered'));
      }
      // If the listener never calls sendResponse and didn't return true,
      // the timeout above rejects with a clear message.
    });
  }

  return { chrome, state, send };
}

/** Poll until fn() is truthy; throw with label on timeout. */
export async function waitFor(fn, { timeout = 5000, interval = 20, label = '' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `waitFor timeout${label ? `: ${label}` : ''} (last=${JSON.stringify(last)})`
  );
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
