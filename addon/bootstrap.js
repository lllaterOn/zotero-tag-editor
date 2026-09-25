/* Zotero 10 supplies these privileged globals in the add-on sandbox. */
var tagEditorStartup = null;
var tagEditorChromeHandle = null;

function install() {}

async function startup({ rootURI }) {
  if (tagEditorStartup) return tagEditorStartup;
  tagEditorStartup = (async () => {
    const addonManagerStartup = Components.classes[
      '@mozilla.org/addons/addon-manager-startup;1'
    ].getService(Components.interfaces.amIAddonManagerStartup);
    tagEditorChromeHandle = addonManagerStartup.registerChrome(
      Services.io.newURI(rootURI + 'chrome.manifest'),
      [['content', 'zotero-tag-editor', rootURI + 'content/']]
    );
    Services.scriptloader.loadSubScriptWithOptions(rootURI + 'content/zotero.js', {
      target: globalThis,
      ignoreCache: true,
    });
    await ZoteroTagEditor.startup(Zotero, Services);
  })();
  try {
    await tagEditorStartup;
  } catch (error) {
    try {
      await globalThis.ZoteroTagEditor?.shutdown();
    } finally {
      tagEditorChromeHandle?.destruct();
      tagEditorChromeHandle = null;
      tagEditorStartup = null;
      delete globalThis.ZoteroTagEditor;
    }
    throw error;
  }
}

async function onMainWindowLoad({ window }) {
  globalThis.ZoteroTagEditor?.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }) {
  globalThis.ZoteroTagEditor?.onMainWindowUnload(window);
}

async function shutdown(_data, reason) {
  try {
    if (tagEditorStartup) await tagEditorStartup;
    await globalThis.ZoteroTagEditor?.shutdown();
  } finally {
    tagEditorStartup = null;
    delete globalThis.ZoteroTagEditor;
    if (reason !== APP_SHUTDOWN) {
      tagEditorChromeHandle?.destruct();
      Services.obs.notifyObservers(null, 'startupcache-invalidate');
    }
    tagEditorChromeHandle = null;
  }
}

// Keep the user's shortcut preference across uninstall/reinstall.
function uninstall() {
  Services.obs.notifyObservers(null, 'startupcache-invalidate');
}
