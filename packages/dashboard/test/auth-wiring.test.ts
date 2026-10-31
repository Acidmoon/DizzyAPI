/**
 * 登录 / 注册接线的护栏。
 *
 * 分两层，缺一不可：
 * 1. **纯逻辑**（`auth-logic.ts`）：落地页分流、`next` 白名单、`code` → 中文文案、验证码格式。
 *    这些能逐字断言，所以不留「大概对」的余地。
 * 2. **源码级**：登录/注册表单真的调了 `@/lib/api`、密码不进 storage / URL / console、
 *    退出登录真的打 `logout()`（不是假装跳登录页）、闸门真的挂在外壳上。
 *    这些用文本断言挡回归 —— 比真浏览器快，也比「肉眼看看」可靠。
 *
 * 内容断言跑在**去掉注释后的源码**上：否则「这里禁止 localStorage」这类说明性注释
 * 会把护栏自己绊倒（护栏约束代码，不约束文案）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import * as logicModule from '../app/src/app/(main)/auth/_components/auth-logic.ts'
import { unwrap } from './helpers/module-interop.ts'

const here = dirname(fileURLToPath(import.meta.url))
const app = resolve(here, '../app/src')

const logic = unwrap<typeof logicModule>(logicModule)

/** `app/src` 下的相对路径读取。 */
function read(relative: string): string {
  return readFileSync(join(app, relative), 'utf8')
}

/** 去掉块注释与行注释（保留 `https://` 这类冒号后的双斜杠）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function readCode(relative: string): string {
  return stripComments(read(relative))
}

const AUTH = 'app/(main)/auth/_components'
const LOGIN_FORM = `${AUTH}/login-form.tsx`
const REGISTER_FORM = `${AUTH}/register-form.tsx`
const GUARD = `${AUTH}/session-guard.tsx`
const NAV_USER = 'app/(main)/dashboard/_components/sidebar/nav-user.tsx'
const SHELL_LAYOUT = 'app/(main)/dashboard/layout.tsx'
const USER_LAYOUT = 'app/(main)/user/layout.tsx'

// ───────────────────────────── 落地页分流 ─────────────────────────────

describe('登录成功后的落地页按角色分流', () => {
  it('管理员进 /dashboard', () => {
    assert.equal(logic.homePathOf(true), '/dashboard')
  })

  it('普通用户进 /user', () => {
    assert.equal(logic.homePathOf(false), '/user')
  })

  it('角色未知时按普通用户处理（fail-safe，不把用户丢进管理台）', () => {
    assert.equal(logic.homePathOf(null), '/user')
    assert.equal(logic.homePathOf(undefined), '/user')
  })
})

// ───────────────────────────── next 白名单 ─────────────────────────────

describe('next 参数只接受站内路径（防开放重定向）', () => {
  it('接受站内路径', () => {
    assert.equal(logic.safeNextPath('/user/keys'), '/user/keys')
    assert.equal(logic.safeNextPath('/dashboard/usage?range=7d'), '/dashboard/usage?range=7d')
  })

  it('拒绝绝对 URL / 协议相对 / 反斜杠', () => {
    assert.equal(logic.safeNextPath('https://evil.example/x'), null)
    assert.equal(logic.safeNextPath('//evil.example/x'), null)
    assert.equal(logic.safeNextPath('/\\evil.example'), null)
    assert.equal(logic.safeNextPath('user/keys'), null)
    assert.equal(logic.safeNextPath(''), null)
    assert.equal(logic.safeNextPath(null), null)
  })

  it('拒绝指回认证页（否则登录后又回登录页 = 死循环）', () => {
    assert.equal(logic.safeNextPath('/auth/v2/login'), null)
    assert.equal(logic.safeNextPath('/auth/v2/register'), null)
  })

  it('从查询串里取 next，非法值当没给', () => {
    assert.equal(logic.nextPathOf('?next=%2Fuser%2Fkeys'), '/user/keys')
    assert.equal(logic.nextPathOf('next=/user/topup'), '/user/topup')
    assert.equal(logic.nextPathOf('?next=//evil.example'), null)
    assert.equal(logic.nextPathOf(''), null)
    assert.equal(logic.nextPathOf(null), null)
  })

  it('被拦下时的跳转地址带上当前页', () => {
    assert.equal(
      logic.loginPathWithNext('/dashboard/users'),
      '/auth/v2/login?next=%2Fdashboard%2Fusers',
    )
    assert.equal(logic.loginPathWithNext('/auth/v2/login'), '/auth/v2/login')
    assert.equal(logic.loginPathWithNext(null), '/auth/v2/login')
  })
})

// ───────────────────────────── 错误文案 ─────────────────────────────

describe('错误按稳定 code 翻中文，不回显服务端原文', () => {
  it('三个高频码各有专门文案', () => {
    assert.equal(
      logic.authErrorTextOf({ code: 'AUTH_CREDENTIALS_INVALID', status: 401 }),
      '邮箱或密码不正确',
    )
    assert.equal(logic.authErrorTextOf({ code: 'AUTH_RATE_LIMITED', status: 429 }), '尝试过于频繁，请稍后再试')
    assert.equal(
      logic.authErrorTextOf({ code: 'AUTH_USER_BANNED', status: 403 }),
      '这个账号已被停用，请联系站点管理员',
    )
  })

  it('注册链路的码也有中文（验证码 / 邮箱占用 / 邮件发送失败）', () => {
    assert.equal(logic.authErrorTextOf({ code: 'AUTH_CODE_INVALID', status: 400 }), '验证码不正确')
    assert.equal(
      logic.authErrorTextOf({ code: 'AUTH_CODE_ATTEMPTS_EXCEEDED', status: 429 }),
      '验证码错误次数过多，请重新获取',
    )
    assert.equal(logic.authErrorTextOf({ code: 'AUTH_EMAIL_TAKEN', status: 409 }), '这个邮箱已经注册过了')
    assert.equal(logic.authErrorTextOf({ code: 'AUTH_MAIL_FAILED', status: 503 }), '验证码发送失败，请稍后再试')
  })

  it('未知 code 按状态码兜底，且**不含**服务端原文 / code 本身', () => {
    const text = logic.authErrorTextOf({ code: 'AUTH_INTERNAL_SECRET_LEAK', status: 500 })
    assert.equal(text, '操作失败，请稍后再试')
    assert.equal(text.includes('AUTH_INTERNAL_SECRET_LEAK'), false)
    assert.equal(logic.authErrorTextOf({ code: 'X', status: 0 }), '网络异常，请检查网络后重试')
  })

  it('异常收窄：ApiError 形状直接用，其它给 CLIENT_UNEXPECTED', () => {
    assert.deepEqual(logic.toAuthIssue({ code: 'AUTH_RATE_LIMITED', status: 429 }), {
      code: 'AUTH_RATE_LIMITED',
      status: 429,
    })
    assert.deepEqual(logic.toAuthIssue(new Error('boom')), { code: 'CLIENT_UNEXPECTED', status: 0 })
    assert.deepEqual(logic.toAuthIssue(undefined), { code: 'CLIENT_UNEXPECTED', status: 0 })
  })
})

// ───────────────────────────── 验证码格式 ─────────────────────────────

describe('验证码格式（服务端 codeDigits 可配 4..10 位）', () => {
  it('接受 4～10 位数字', () => {
    assert.equal(logic.isVerificationCode('1234'), true)
    assert.equal(logic.isVerificationCode('123456'), true)
    assert.equal(logic.isVerificationCode('1234567890'), true)
    assert.equal(logic.isVerificationCode(' 123456 '), true)
  })

  it('拒绝太短 / 太长 / 非数字', () => {
    assert.equal(logic.isVerificationCode('123'), false)
    assert.equal(logic.isVerificationCode('12345678901'), false)
    assert.equal(logic.isVerificationCode('abcdef'), false)
    assert.equal(logic.isVerificationCode(''), false)
  })

  it('重发冷却秒数向上取整，最少 1 秒', () => {
    assert.equal(logic.resendSecondsOf(60_000), 60)
    assert.equal(logic.resendSecondsOf(1_500), 2)
    assert.equal(logic.resendSecondsOf(0), 1)
    assert.equal(logic.resendSecondsOf(-5), 1)
    assert.equal(logic.resendSecondsOf(Number.NaN), 1)
  })
})

// ───────────────────────────── 源码护栏 ─────────────────────────────

describe('登录 / 注册表单真的接了数据层', () => {
  it('登录表单调 login()，注册表单调两步接口', () => {
    const login = readCode(LOGIN_FORM)
    assert.ok(login.includes('authApi.login('), '登录表单没有调用 login()')
    assert.ok(login.includes('@/lib/api'), '登录表单没有走 @/lib/api')
    const register = readCode(REGISTER_FORM)
    assert.ok(register.includes('authApi.requestRegistration('), '注册表单没有发验证码')
    assert.ok(register.includes('authApi.confirmRegistration('), '注册表单没有提交验证码')
  })

  it('不再有「接口尚未接通」的占位提示', () => {
    for (const file of [LOGIN_FORM, REGISTER_FORM]) {
      const code = readCode(file)
      assert.equal(code.includes('尚未接通'), false, `${file} 还留着占位提示`)
      assert.equal(code.includes('TODO(数据层)'), false, `${file} 还留着 TODO(数据层)`)
    }
  })

  it('提交中有 pending 态（aria-busy + 带省略号的文案），不是点了没反应', () => {
    for (const file of [LOGIN_FORM, REGISTER_FORM]) {
      const code = readCode(file)
      assert.ok(code.includes('aria-busy={pending}'), `${file} 缺少 aria-busy`)
      assert.ok(code.includes('…'), `${file} 的加载态文案没有用省略号`)
    }
  })

  it('失败就地报错并播报（role="alert"）', () => {
    for (const file of [LOGIN_FORM, REGISTER_FORM]) {
      assert.ok(readCode(file).includes('role="alert"'), `${file} 的错误没有 role="alert"`)
    }
  })

  it('页面不自己 fetch：一律走 @/lib/api（否则漏 X-Requested-With / 错误信封 / 401 处理）', () => {
    for (const file of [LOGIN_FORM, REGISTER_FORM, GUARD]) {
      const code = readCode(file)
      assert.equal(/[^.\w]fetch\(/.test(code), false, `${file} 直接调了 fetch()`)
      assert.ok(code.includes('@/lib/api'), `${file} 没有走 @/lib/api`)
    }
  })
})

describe('秘密纪律：密码 / 验证码不进 URL、不进 storage、不进 console', () => {
  for (const file of [LOGIN_FORM, REGISTER_FORM, GUARD]) {
    it(`${file} 不碰 localStorage / sessionStorage / document.cookie`, () => {
      const code = readCode(file)
      assert.equal(code.includes('localStorage'), false, `${file} 用了 localStorage`)
      assert.equal(code.includes('sessionStorage'), false, `${file} 用了 sessionStorage`)
      assert.equal(code.includes('document.cookie'), false, `${file} 读了 cookie`)
    })

    it(`${file} 不把秘密拼进 URL`, () => {
      const code = readCode(file)
      assert.equal(code.includes('password='), false, `${file} 把密码拼进了 URL`)
      assert.equal(code.includes('code='), false, `${file} 把验证码拼进了 URL`)
    })

    it(`${file} 不打 console`, () => {
      assert.equal(/console\.\w+\(/.test(readCode(file)), false, `${file} 打了 console`)
    })
  }

  it('登录成功后清空密码', () => {
    assert.ok(readCode(LOGIN_FORM).includes('password: ""'), '登录表单没有清空密码')
  })

  it('注册第一步成功后清空密码（第二步用不到它）', () => {
    const code = readCode(REGISTER_FORM)
    assert.ok(code.includes('password: "", confirmPassword: ""'), '注册表单没有清空密码')
  })

  it('「验证码已发送」照实说明日志投递，不假装发信成功', () => {
    assert.ok(logic.CODE_SENT_NOTICE.includes('日志'), '文案没有说明日志投递')
    assert.ok(readCode(REGISTER_FORM).includes('CODE_SENT_NOTICE'), '注册表单没有用统一文案')
  })
})

describe('会话闸门与登出', () => {
  it('闸门挂在外壳上（dashboard 布局），/user 段直接转接，只有一份实现', () => {
    assert.ok(readCode(SHELL_LAYOUT).includes('<SessionGuard'), '外壳没有挂 SessionGuard')
    const userLayout = readCode(USER_LAYOUT)
    assert.ok(userLayout.includes('dashboard/layout'), '/user 布局没有转接外壳（等于复制了一份壳）')
    assert.equal(userLayout.includes('<SessionGuard'), false, '/user 布局自己又挂了一层闸门')
  })

  it('闸门用 fetchSession 判 401 并跳登录页（静态导出没有服务端 302）', () => {
    const code = readCode(GUARD)
    assert.ok(code.includes('fetchSession('), '闸门没有取会话')
    assert.ok(code.includes('isUnauthorized'), '闸门没有处理 401')
    assert.ok(code.includes('loginPathWithNext('), '闸门跳登录页时没有带 next')
    assert.ok(code.includes('router.replace('), '闸门没有做客户端跳转')
    assert.equal(code.includes('redirect('), false, '闸门用了服务端 redirect（静态导出不适用）')
  })

  it('普通用户访问 /dashboard 会被送回 /user', () => {
    const code = readCode(GUARD)
    assert.ok(code.includes('requiresAdmin'), '闸门没有管理员判定')
    assert.ok(code.includes('homePathOf(false)'), '闸门没有把普通用户送回 /user')
  })

  it('退出登录真的调 logout()，不是假装跳登录页', () => {
    const navUser = readCode(NAV_USER)
    assert.ok(navUser.includes('signOut'), '用户菜单没有调用 signOut')
    assert.equal(
      navUser.includes('<a href="/auth/v2/login">'),
      false,
      '退出登录还是假的（只跳链接，会话没清）',
    )
    const guard = readCode(GUARD)
    assert.ok(guard.includes('authApi.logout('), 'signOut 没有打登出接口')
    assert.ok(guard.includes('LOGIN_PATH'), 'signOut 没有回登录页')
  })

  it('侧栏用户菜单显示真实会话用户（不是占位「未登录」）', () => {
    const navUser = readCode(NAV_USER)
    assert.ok(navUser.includes('useSession()'), '用户菜单没有读会话')
    assert.ok(navUser.includes('session.session.user.name'), '用户菜单没有用真实用户名')
  })
})
