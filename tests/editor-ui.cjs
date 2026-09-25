// Real packaged XHTML/controller smoke test with a simulated Zotero bridge.
// This does not claim to validate Zotero chrome integration or its database.
const {chromium}=require(process.env.TAG_EDITOR_PLAYWRIGHT_DIR || 'playwright');
const {build}=require('esbuild');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const output=path.join(root,'work','editor-ui');

async function run(){
  await fs.mkdir(output,{recursive:true});
  await build({absWorkingDir:root,entryPoints:['src/editor.ts'],tsconfig:path.join(root,'tsconfig.json'),bundle:true,platform:'browser',format:'iife',target:'firefox128',outfile:path.join(output,'editor.js')});
  const xml=(await fs.readFile(path.join(root,'addon','content','editor.xhtml'),'utf8'))
    .replaceAll('chrome://zotero-tag-editor/content/','./')
    .replace('<script src="./editor.js"','<script src="./bridge.js"></script>\n  <script src="./editor.js"');
  await fs.writeFile(path.join(output,'editor.xhtml'),xml);
  await fs.copyFile(path.join(root,'addon','content','editor.css'),path.join(output,'editor.css'));
  await fs.writeFile(path.join(output,'bridge.js'),String.raw`
const clone=value=>JSON.parse(JSON.stringify(value));
const initial=[
 {id:1,libraryID:1,title:'阀厅套管抗震研究',tags:[{tag:'抗震分析',type:0},{tag:'待精读',type:0},{tag:'有限元',type:0}]},
 {id:2,libraryID:1,title:'电气设备振动台试验',tags:[{tag:'抗震分析',type:0},{tag:'已精读',type:0},{tag:'试验研究',type:0}]},
 {id:3,libraryID:1,title:'设备动力响应参数研究',tags:[{tag:'抗震分析',type:0},{tag:'待精读',type:0},{tag:'参数分析',type:0}]}
];
const fixture=window.__fixture={db:clone(initial),saved:null,closed:0,failSave:false,deferSave:false,failUndo:false,shortcut:'Ctrl+T'};
window.close=()=>{fixture.closed++;};
window.arguments=[{
 initialItems:clone(initial),availableTags:['抗震分析','待精读','已精读','有限元','试验研究','参数分析','写作引用'],colors:{'待精读':'#2765b2'},context:'library',
 save:async (base,draft)=>{if(fixture.deferSave)await new Promise(resolve=>fixture.releaseSave=resolve);if(fixture.failSave){const e=new Error('标签已被其他操作修改');e.name='ConflictError';throw e;}fixture.saved={before:clone(base),after:clone(draft)};fixture.db=clone(draft);},
 reload:async()=>clone(fixture.db),
 undo:async()=>{if(fixture.failUndo)throw new Error('保存后标签发生变化');const result=clone(fixture.saved.before);fixture.db=result;fixture.saved=null;return result;},
 undoCount:()=>fixture.saved?.before.length||0,getShortcut:()=>fixture.shortcut,
 setShortcut:value=>{if(!/^Ctrl\+Shift\+[A-Z]$/.test(value))throw new Error('无效组合键');fixture.shortcut=value;}
}];
`);
  const browser=await chromium.launch({headless:true,channel:'msedge'});
  try{
    const page=await browser.newPage({viewport:{width:760,height:760}});
    const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
    let acceptDialog=true;
    page.on('dialog',dialog=>acceptDialog ? dialog.accept() : dialog.dismiss());
    async function fresh(){await page.goto(pathToFileURL(path.join(output,'editor.xhtml')).href);try{await page.locator('#tags [data-tag]').first().waitFor({timeout:5000});}catch(e){console.error(await page.locator('body').textContent());throw e;}}
    async function action(tag,op){await page.locator('#tags [data-tag]').filter({has:page.locator('.tag-name',{hasText:new RegExp('^'+tag+'$')})}).click();await page.locator('#inspector [data-action="'+op+'"]').click();}
    const checks=[];
    const retarget=()=>page.evaluate(()=>{
      const bridge={...window.arguments[0],initialItems:[{id:9,libraryID:1,title:'新选择',tags:[{tag:'新目标',type:0}]}]};
      const detail={bridge,accepted:false};
      window.dispatchEvent(new CustomEvent('zotero-tag-editor-retarget',{detail,cancelable:true}));
      return detail.accepted;
    });
    await fresh();
    assert(await retarget());
    assert.equal(await page.locator('#target-summary').textContent(),'新选择');
    await fresh();
    await page.locator('#search').fill('未保存');await page.locator('#search').press('Enter');
    acceptDialog=false;
    assert.equal(await retarget(),false);
    assert((await page.locator('#tags').innerText()).includes('未保存'));
    acceptDialog=true;
    assert(await retarget());
    assert(!(await page.locator('#tags').innerText()).includes('未保存'));
    assert(await page.locator('#save').isDisabled());
    checks.push('New selection refreshes clean editor; cancelling retains dirty draft; accepting resets targets and draft');
    await fresh();assert.equal(await page.evaluate(()=>document.contentType),'application/xhtml+xml');
    assert.equal(await page.locator('#tags button').first().evaluate(e=>e.namespaceURI),'http://www.w3.org/1999/xhtml');
    await action('待精读','fill');assert.match(await page.locator('#change-summary').innerText(),/1 篇/);
    await page.locator('#undo-step').click();assert(await page.locator('#save').isDisabled());
    checks.push('Real XHTML creates HTML namespace controls; partial fill and undo');
    await action('待精读','rename');await page.locator('#rename-input').fill('已精读');await page.locator('#rename-input').press('Enter');
    assert.match(await page.locator('#change-summary').innerText(),/2 篇/);
    await page.locator('#search').press('Control+Enter');await page.waitForFunction(()=>window.__fixture.closed===1);
    const state=await page.evaluate(()=>window.__fixture.db);
    assert(state.every(i=>i.tags.some(t=>t.tag==='已精读')));
    assert(state.every(i=>!i.tags.some(t=>t.tag==='待精读')));
    assert(state[0].tags.some(t=>t.tag==='有限元'));
    checks.push('Rename merge and keyboard save preserve unrelated labels');
    await fresh();await page.locator('#search').fill('<img src=x onerror=alert(1)>');await page.locator('#search').press('Enter');
    assert.equal(await page.locator('#tags img').count(),0);assert((await page.locator('#tags').innerText()).includes('<img'));
    await page.locator('#cancel').click();assert.match(await page.locator('#message').innerText(),/放弃尚未保存/);
    await page.locator('[data-message-action="stay"]').click();
    checks.push('Arbitrary label text is escaped; dirty close can be cancelled');
    await page.evaluate(()=>window.__fixture.failSave=true);await page.locator('#save').click();
    await page.waitForFunction(()=>document.getElementById('message').textContent.includes('标签已被其他操作修改'));
    assert.equal(await page.evaluate(()=>window.__fixture.closed),0);
    assert((await page.locator('#tags').innerText()).includes('<img'));
    await page.locator('[data-message-action="reload"]').click();
    await page.waitForFunction(()=>document.getElementById('save').disabled);
    assert(!(await page.locator('#tags').innerText()).includes('<img'));
    checks.push('Save conflict retains draft; explicit reload discards it');
    await fresh();await page.locator('#search').fill('写作引用');await page.locator('#search').press('Enter');
    await page.evaluate(()=>window.__fixture.deferSave=true);await page.locator('#save').click();
    assert(await page.locator('#search').isDisabled());assert(await page.locator('#cancel').isDisabled());
    await page.evaluate(()=>window.__fixture.releaseSave());await page.waitForFunction(()=>window.__fixture.closed===1);
    checks.push('Pending save disables edits and close actions');
    await fresh();
    await page.locator('#shortcut').press('Control+Shift+K');
    assert.equal(await page.locator('#shortcut').evaluate(el=>el.value),'Ctrl+Shift+K');
    await page.locator('#save-shortcut').click();
    assert.equal(await page.evaluate(()=>window.__fixture.shortcut),'Ctrl+Shift+K');
    assert.equal(await page.locator('#shortcut-hint').textContent(),'✓ 已生效');
    assert(!(await page.locator('#announcement').textContent()).includes('快捷键'));
    await page.locator('#shortcut').press('Control+Enter');
    assert.equal(await page.evaluate(()=>window.__fixture.closed),0);
    await page.locator('#shortcut').press('Escape');
    assert.equal(await page.locator('#shortcut').evaluate(el=>el.value),'Ctrl+Shift+K');
    checks.push('Shortcut recording, apply and Escape restore; capture does not trigger save or close');
    await page.setViewportSize({width:720,height:520});
    assert(await page.locator('#save').evaluate(el=>el.getBoundingClientRect().bottom <= window.innerHeight));
    const positions=()=>page.evaluate(()=>['inspector','shortcut','save'].map(id=>document.getElementById(id).getBoundingClientRect().top));
    const baseline=await positions();
    await page.locator('#search').fill('研究');
    assert.deepEqual(await positions(),baseline);
    assert(await page.locator('#suggestions').isVisible());
    await page.locator('#search').press('Escape');
    assert(await page.locator('#suggestions').isHidden());
    assert.equal(await page.evaluate(()=>window.__fixture.closed),0);
    await page.locator('#search').fill('候选');
    await page.locator('#shortcut').click();
    assert(await page.locator('#suggestions').isHidden());
    for(let i=0;i<35;i++){
      await page.locator('#search').fill('批量标签'+i);
      await page.locator('#search').press('Enter');
    }
    assert.deepEqual(await positions(),baseline);
    assert(await page.locator('#tags').evaluate(el=>el.scrollHeight>el.clientHeight));
    assert(await page.locator('.content').evaluate(el=>el.scrollHeight<=el.clientHeight+1));
    checks.push('Suggestions and 35 added tags do not move controls; only tag list scrolls; Escape/outside dismiss; shortcut feedback stays local');
    await fresh();
    await page.screenshot({path:path.join(output,'light.png')});
    await page.locator('#search').fill('研究');
    await page.screenshot({path:path.join(output,'suggestions.png')});
    await page.locator('#search').press('Escape');
    await page.emulateMedia({colorScheme:'dark'});await page.screenshot({path:path.join(output,'dark.png')});
    await page.setViewportSize({width:380,height:800});await page.screenshot({path:path.join(output,'narrow.png')});
    const widths=await page.evaluate(()=>({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
    assert(widths.scroll<=widths.client+1,JSON.stringify(widths));assert.deepEqual(errors,[]);
    checks.push('Light/dark and narrow layout render without horizontal overflow or script errors');
    await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,checks},null,2));
    console.log(JSON.stringify({passed:true,checks},null,2));
  }finally{await browser.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
