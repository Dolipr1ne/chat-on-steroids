/** Isolated Electron permission-panel acceptance. Synthetic configuration only;
 * no ChatGPT/browser/OS approvals, real user folders, or installed settings change. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
if (!process.versions.electron) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-tool-access-fixture-'));
  const env = { ...process.env, COS_TOOL_ACCESS_FIXTURE: profile }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    const child = require('node:child_process').spawnSync(require('electron'), [__filename], {
      env, encoding: 'utf8', windowsHide: true, timeout: 90000
    });
    process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || ''); process.exitCode = child.status ?? 1;
  } finally {
    const resolved = fs.realpathSync(profile);
    if (!path.basename(resolved).startsWith('cos-tool-access-fixture-') || path.dirname(resolved) !== fs.realpathSync(os.tmpdir())) throw Error('Unexpected fixture cleanup location');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
} else {
  const { app, BrowserWindow, dialog } = require('electron');
  const profile = process.env.COS_TOOL_ACCESS_FIXTURE;
  if (!profile || !path.basename(profile).startsWith('cos-tool-access-fixture-')) throw Error('An isolated profile is required.');
  app.setPath('userData', profile);
  app.whenReady().then(async () => {
    const root = path.resolve(__dirname, '..'), output = path.join(root, 'outputs/tool-access-chromium');
    fs.mkdirSync(output, { recursive: true });
    const esbuild = require('esbuild');
    const bundle = async (entry, options = {}) => (await esbuild.build({ entryPoints: [path.join(root, entry)],
      bundle: true, write: false, ...options })).outputFiles[0].text;
    const main = await esbuild.build({ stdin: { contents: `export * from './src/main/tool-access.ts'; export * from './src/main/config.ts';`,
      resolveDir: root }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['electron'] });
    const mainFile = path.join(output, 'main.cjs'); fs.writeFileSync(mainFile, main.outputFiles[0].text);
    const backend = require(mainFile); backend.initConfigPath(profile);
    const original = backend.defaultConfig(); original.readOnly = true; original.capabilities.command = false;
    original.multiAgent.allowUnattributedCalls = false; original.goal.enabled = false;
    await backend.saveConfig(original);
    const preload = path.join(output, 'preload.cjs'); fs.writeFileSync(preload, await bundle('src/preload/index.ts', { platform: 'node', format: 'cjs', external: ['electron'] }));
    const renderer = await bundle('src/renderer/tool-access.ts', { platform: 'browser', format: 'iife', globalName: 'toolAccess' });
    const win = new BrowserWindow({ show: false, width: 1200, height: 850,
      webPreferences: { preload, sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false } });
    const owner = new Proxy(win, { get(target, key) {
      if (key === 'isFocused' || key === 'isVisible') return () => true;
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    let confirmations = 0, published = 0;
    dialog.showMessageBox = async (_window, options) => {
      assert.equal(options.defaultId, 1); assert.equal(options.cancelId, 1);
      assert.match(options.detail, /not OS-sandboxed/); confirmations++; return { response: 0, checkboxChecked: false };
    };
    const dispose = backend.registerToolAccessIpc(() => owner, async () => { published++; });
    const styles = ['styles.css', 'tool-access.css'].map(file => fs.readFileSync(path.join(root, 'src/renderer', file), 'utf8')).join('\n');
    const html = path.join(output, 'fixture.html');
    fs.writeFileSync(html, `<!doctype html><html data-theme="dark"><meta charset="UTF-8"><style>${styles}</style><body><form><button type="button" id="access">Access</button><textarea id="draft">Keep this authored draft</textarea></form></body></html>`);
    await win.loadFile(html);
    const evaluate = script => win.webContents.executeJavaScript(script, true);
    await evaluate(renderer);
    await evaluate(`window.control=toolAccess.initToolAccess({button:document.getElementById('access'),api:window.api}); window.control.open()`);
    assert.equal(confirmations, 0); assert.equal(backend.getConfig().readOnly, true);
    const geometry = [];
    for (const width of [1200, 900, 520]) {
      win.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width, height: 850 },
        viewPosition: { x: 0, y: 0 }, viewSize: { width, height: 850 }, deviceScaleFactor: 1, scale: 1 });
      await new Promise(resolve => setTimeout(resolve, 50));
      const rect = await evaluate(`(()=>{const node=document.querySelector('dialog'),r=node.getBoundingClientRect();return {width:innerWidth,left:r.left,right:r.right,top:r.top,bottom:r.bottom,overflow:node.scrollWidth>node.clientWidth};})()`);
      assert.ok(rect.left >= 8 && rect.right <= width - 8 && rect.top >= 8 && rect.bottom <= 842); assert.equal(rect.overflow, false); geometry.push(rect);
    }
    await evaluate(`document.querySelector('[data-action="apply"]').click()`);
    const until = Date.now() + 10000;
    while (published === 0 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(confirmations, 1); assert.equal(published, 1);
    assert.equal(backend.getConfig().readOnly, false); assert.equal(backend.getConfig().capabilities.command, true);
    assert.deepEqual(backend.getConfig().roots, original.roots); assert.deepEqual(backend.getConfig().multiAgent, original.multiAgent);
    assert.deepEqual(backend.getConfig().goal, original.goal);
    assert.equal(await evaluate(`document.getElementById('draft').value`), 'Keep this authored draft');
    await evaluate(`window.control.close(); window.control.dispose()`);
    assert.equal(await evaluate(`document.querySelectorAll('.tool-access-dialog').length`), 0);
    const receipt = { ok: true, isolatedSettingsOnly: true, confirmations, published, draftPreserved: true,
      rootsUnchanged: true, automationUnchanged: true, attributionPolicyUnchanged: true, geometry };
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt, null, 2));
    dispose(); win.destroy(); app.quit();
  }).catch(error => { console.error(error.message); app.exit(1); });
}
