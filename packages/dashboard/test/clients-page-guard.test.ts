/**
 * 护栏：客户端档案页与账号页的「客户端档案」入口。
 *
 * 这条防的还是同一类问题：**写完了但没接上** —— 页面建了没登记侧栏、表单建了没挂进 board、
 * 确认弹窗换成浏览器原生 `confirm`、账号编辑里忘了这个下拉。
 * `pnpm test` 与 `next build` 都不会报这些，只有真浏览器或读代码才看得见。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const APP = join(import.meta.dirname, '..', 'app', 'src')
const COMPONENTS = join(APP, 'app', '(main)', 'dashboard', '_components')

function source(...segments: string[]): string {
  return readFileSync(join(...segments), 'utf8')
}

/** 去掉注释后的源码（否定断言要看代码，注释里写「不许用 window.confirm」不算违规）。 */
function code(path: string): string {
  return source(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

test('客户端档案页：page 挂 board，board 挂表单与确认弹窗', () => {
  const page = source(APP, 'app', '(main)', 'dashboard', 'clients', 'page.tsx')
  assert.ok(page.includes('_components/clients-board'), 'clients/page.tsx 没挂 ClientsBoard')

  const board = source(COMPONENTS, 'clients-board.tsx')
  for (const child of ['./client-profile-form"', './client-profile-confirm-dialog"']) {
    assert.ok(board.includes(child), `clients-board.tsx 没挂 ${child}`)
  }
})

test('客户端档案页：侧栏登记了 /dashboard/clients', () => {
  const sidebar = source(APP, 'navigation', 'sidebar', 'sidebar-items.ts')
  assert.ok(sidebar.includes('"/dashboard/clients"'), '侧栏没登记客户端档案页（用户只能手输 URL）')
})

test('客户端档案页：全部自研控件（无原生 select / window.confirm / 裸 dialog）', () => {
  for (const file of ['clients-board.tsx', 'client-profile-form.tsx', 'client-profile-confirm-dialog.tsx']) {
    const text = code(join(COMPONENTS, file))
    assert.equal(/\bwindow\.confirm\s*\(/.test(text), false, `${file} 用了 window.confirm`)
    assert.equal(/\bwindow\.prompt\s*\(/.test(text), false, `${file} 用了 window.prompt`)
    assert.equal(/\bwindow\.alert\s*\(/.test(text), false, `${file} 用了 window.alert`)
    assert.equal(/<select\b/.test(text), false, `${file} 用了原生 <select>`)
    assert.equal(/<dialog\b/.test(text), false, `${file} 用了原生 <dialog>`)
  }
  const confirmDialog = code(join(COMPONENTS, 'client-profile-confirm-dialog.tsx'))
  assert.ok(confirmDialog.includes('AlertDialog'), '删除 / 恢复出厂没有二次确认')
})

test('客户端档案页：删除与恢复出厂都真的走端点', () => {
  const dialog = source(COMPONENTS, 'client-profile-confirm-dialog.tsx')
  assert.ok(dialog.includes('adminClients.deleteClientMask(api, profile.id)'), '删除没走 deleteClientMask')
  assert.ok(dialog.includes('adminClients.resetClientMask(api, profile.id)'), '恢复出厂没走 resetClientMask')

  const board = source(COMPONENTS, 'clients-board.tsx')
  assert.ok(board.includes('adminClients.listClientMasks(api)'), '列表没走 listClientMasks')
  assert.ok(board.includes('adminClients.createClientMask(api'), '新建没走 createClientMask')
  assert.ok(board.includes('adminClients.updateClientMask(api'), '保存没走 updateClientMask')
  // 内置档案只能停用 / 恢复出厂，删除按钮只给自定义的（服务端也会拒，但页面不该给出这个入口）。
  assert.ok(board.includes('selected.builtin ?'), '内置 / 自定义没分开给按钮')
})

test('账号编辑弹窗：有「客户端档案」下拉，且取的是启用中的档案', () => {
  const dialog = source(COMPONENTS, 'account-edit-dialog.tsx')
  assert.ok(dialog.includes('adminClients'), '账号编辑没读客户端档案列表')
  assert.ok(dialog.includes('listClientMasks'), '账号编辑没调 listClientMasks')
  assert.ok(dialog.includes('客户端档案'), '账号编辑没有「客户端档案」这一栏')
  assert.ok(dialog.includes('不伪装'), '没有「不伪装」选项（= 清空）')
  // 停用 / 已删的档案也要能显示出来，否则保存时会把 clientProfile 冲掉。
  assert.ok(dialog.includes('enabledProfiles'), '没按 enabled 过滤')
  assert.ok(dialog.includes('currentProfileFallback'), '当前档案不在启用列表时没有兜底选项')
})
