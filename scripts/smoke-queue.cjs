/* Runs the production Electron renderer/preload/main with an isolated profile. */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const artifacts = path.join(root, 'artifacts')
  fs.mkdirSync(artifacts, { recursive: true })
  const profile = fs.mkdtempSync(path.join(artifacts, 'queue-smoke-'))
  const options = { sourceLanguage: 'en', transcriptionModelId: 'whisper-large-v3-turbo', translationProfileId: 'builtin-qwen3', translate: false }
  const tasks = Array.from({ length: 3 }, (_, index) => {
    const name = `验收视频 ${index + 1}`
    const mediaPath = path.join(profile, `${name}.wav`)
    const wav = Buffer.alloc(32044)
    wav.write('RIFF', 0); wav.writeUInt32LE(32036, 4); wav.write('WAVEfmt ', 8)
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
    wav.write('data', 36); wav.writeUInt32LE(32000, 40)
    fs.writeFileSync(mediaPath, wav)
    const project = {
      schemaVersion: 2, id: crypto.randomUUID(), title: name,
      media: { path: mediaPath, name: `${name}.wav`, size: wav.length, durationMs: 1000, kind: 'audio', audioCodec: 'pcm_s16le' },
      sourceLanguage: 'en', targetLanguage: 'zh-CN', modelVersions: { whisper: 'test', translator: 'test', vad: 'test' },
      settings: { translationStyle: 'natural', minSegmentMs: 1000, maxSegmentMs: 8000, transcriptionModelId: options.transcriptionModelId, translationProfileId: options.translationProfileId },
      segments: [{ id: 'segment-1', startMs: 0, endMs: 1000, sourceText: 'Acceptance fixture', translatedText: '验收原始字幕', words: [], confidence: 1, status: 'generated' }],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }
    const filePath = path.join(profile, `${name}.zimu`)
    fs.writeFileSync(filePath, JSON.stringify(project))
    return { jobId: crypto.randomUUID(), projectId: project.id, project, filePath, options, operation: 'generate', state: ['succeeded', 'running', 'waiting'][index], stage: ['completed', 'transcribing', 'queued'][index], progress: index ? 30 : 100, message: '验收任务' }
  })
  fs.writeFileSync(path.join(profile, 'generation-queue.json'), JSON.stringify({ tasks, paused: false, concurrency: 2, recovery: false }))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  for (const stage of ['first', 'restart']) {
    const result = spawnSync(require('electron'), [__filename, profile, stage], { cwd: root, env, encoding: 'utf8', timeout: 60000, windowsHide: true })
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.status !== 0) { process.stderr.write(result.stderr || String(result.error || 'Electron acceptance failed')); process.exit(1) }
  }
  console.log(`Electron queue acceptance passed. Screenshots: ${profile}`)
} else {
  const { app, BrowserWindow, dialog } = require('electron')
  const profile = process.argv[2]
  const stage = process.argv[3]
  app.setPath('userData', profile)
  app.setAppPath(root)
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: JSON.parse(fs.readFileSync(path.join(profile, 'generation-queue.json'), 'utf8')).tasks.map((task) => task.project.media.path) })
  app.on('browser-window-created', (_event, window) => {
    window.webContents.on('preload-error', (_event, _preload, error) => console.error('Preload error:', error.message))
    window.webContents.on('console-message', (event) => { if (event.level === 'error') console.error('Renderer error:', event.message) })
    window.webContents.once('did-finish-load', () => {
      void verify(window).then(() => app.exit(0)).catch((error) => { console.error(error.stack); app.exit(1) })
    })
  })
  require(path.join(root, 'out/main/index.js'))

  async function verify(window) {
    const run = (source) => window.webContents.executeJavaScript(source)
    const wait = async (source) => {
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        if (await run(source)) return
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error(`Timed out: ${source}`)
    }
    const click = async (label) => {
      await wait(`[...document.querySelectorAll('button')].some((item) => (item.textContent.trim() === ${JSON.stringify(label)} || item.getAttribute('aria-label') === ${JSON.stringify(label)}) && !item.disabled)`)
      await run(`(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === ${JSON.stringify(label)} || item.getAttribute('aria-label') === ${JSON.stringify(label)}); if (!button || button.disabled) throw new Error('Button unavailable'); button.click() })()`)
    }
    const selectProject = async (id) => {
      await run(`(() => { const select = document.querySelector('nav select'); select.value = ${JSON.stringify(id)}; select.dispatchEvent(new Event('change', { bubbles: true })) })()`)
      await wait(`document.querySelector('nav select')?.value === ${JSON.stringify(id)} && !!document.querySelector('textarea')`)
    }
    const capture = async (name) => {
      await run('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      await new Promise((resolve) => setTimeout(resolve, 150))
      fs.writeFileSync(path.join(profile, name), (await window.webContents.capturePage()).toPNG())
    }
    await wait(`document.body.innerText.includes('任务中心') && !!window.zimu`)
    const snapshot = await run('window.zimu.queue.snapshot()')
    assert.equal(snapshot.paused, true)
    assert.equal(snapshot.tasks[0].state, 'succeeded')
    assert.equal(snapshot.tasks.length, 3)
    if (stage === 'restart') {
      assert.equal(snapshot.tasks[0].project.segments[0].translatedText, '验收编辑保留')
      assert.equal(snapshot.tasks[1].state, 'failed')
      assert.equal(snapshot.tasks[2].state, 'canceled')
      assert.equal(snapshot.tasks.filter((task) => task.state === 'running').length, 0)
      console.log('PASS actual Electron restart preserves saved edits and remains paused')
      return
    }
    assert.equal(snapshot.tasks[1].state, 'interrupted')
    assert.equal(snapshot.recovery, true)
    await wait(`document.body.innerText.includes('已恢复上次队列')`)
    await capture('recovery.png')
    await click('关闭任务中心')
    await selectProject(snapshot.tasks[0].projectId)
    await run(`(() => { const input = document.querySelector('textarea[aria-label="第 1 段中文"]'); input.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '验收编辑保留'); input.dispatchEvent(new Event('input', { bubbles: true })); input.blur() })()`)
    await selectProject(snapshot.tasks[1].projectId)
    assert.equal(await run(`document.querySelector('textarea').matches(':disabled')`), true)
    await selectProject(snapshot.tasks[0].projectId)
    assert.equal(await run(`document.querySelector('textarea[aria-label="第 1 段中文"]').value`), '验收编辑保留')
    await click('保存')
    await wait(`document.body.innerText.includes('项目已保存')`)
    assert.equal(JSON.parse(fs.readFileSync(snapshot.tasks[0].filePath, 'utf8')).segments[0].translatedText, '验收编辑保留')
    await capture('editor.png')
    console.log('PASS project switching, read-only generation and retained editable subtitles')
    await click('批量生成字幕')
    await wait(`document.body.innerText.includes('统一参数')`)
    await capture('batch.png')
    assert.equal(await run(`[...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent.trim() === '加入队列').disabled`), true)
    await click('添加视频')
    await wait(`document.querySelectorAll('[role="dialog"] section').length === 3 && document.querySelectorAll('[role="dialog"] [role="alert"]').length === 3`)
    assert.equal(await run(`[...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent.trim() === '加入队列').disabled`), true)
    await click('单项覆盖')
    await wait(`document.querySelectorAll('[role="dialog"] fieldset').length === 2`)
    await capture('batch-validation.png')
    await click('关闭批量配置')
    await run(`(() => { const button = [...document.querySelectorAll('nav button')].find((item) => item.textContent.includes('任务中心')); button.click() })()`)
    await wait(`document.body.innerText.includes('继续队列')`)
    await run(`(() => { const dialog = document.querySelector('[role="dialog"]'); const select = dialog.querySelector('select'); select.value = '1'; select.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await wait(`window.zimu.queue.snapshot().then((queue) => queue.concurrency === 1)`)
    await wait(`(() => { const section = document.querySelectorAll('[role="dialog"] section')[2]; return [...section.querySelectorAll('button')].some((button) => button.textContent.trim() === '取消' && !button.disabled) })()`)
    await run(`(() => { const sections = [...document.querySelectorAll('[role="dialog"] section')]; const button = [...sections[2].querySelectorAll('button')].find((item) => item.textContent.trim() === '取消'); button.click() })()`)
    await wait(`window.zimu.queue.snapshot().then((queue) => queue.tasks[2].state === 'canceled')`)
    await click('继续队列')
    await wait(`window.zimu.queue.snapshot().then((queue) => queue.tasks[1].state === 'failed')`)
    const failed = await run('window.zimu.queue.snapshot()')
    assert.equal(failed.tasks[0].state, 'succeeded')
    assert.equal(failed.tasks[0].project.segments[0].translatedText, '验收编辑保留')
    assert.equal(failed.tasks[2].state, 'canceled')
    await capture('tasks.png')
    assert.equal(BrowserWindow.getAllWindows().length, 1)
    console.log('PASS multi-file selection, per-row validation/overrides, concurrency controls, cancel and failed preflight isolation')
  }
}
