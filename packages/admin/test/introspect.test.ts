/**
 * 内省层的单测：方法枚举与计数。
 *
 * 图本身要真 Loader 才建得出来，放在 admin.test.ts 里跑。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, Service, symbols } from 'cordis'
import { collectMethods, pluginCounts, type AdminPluginNode } from '../src/introspect.ts'

test('方法枚举：只收字符串键上的函数，跳过 constructor 与下划线私有', () => {
  class Base {
    baseMethod(a: number, b: number): number {
      return a + b
    }
  }
  class Demo extends Base {
    own(): void {}
    overrideBase(): void {}
    _hidden(): void {}
  }
  // 子类覆盖同名方法时，登记的是子类那个。
  ;(Demo.prototype as unknown as { baseMethod: () => void }).baseMethod = () => {}

  const { methods, callable } = collectMethods(new Demo())
  const names = methods.map((method) => method.name)

  assert.ok(names.includes('own'), '自有方法应该在')
  assert.ok(names.includes('baseMethod'), '原型链上的方法应该在')
  assert.ok(!names.includes('_hidden'), '下划线开头视为私有')
  assert.ok(!names.includes('constructor'), 'constructor 不是接口')
  assert.ok(!names.includes('toString'), 'Object.prototype 上的东西不是这个对象的接口')
  assert.equal(callable, false, '普通对象不是可调用服务')

  const base = methods.find((method) => method.name === 'baseMethod')
  assert.equal(base?.arity, 0, '应当记子类覆盖后的函数（0 个参数），不是父类的 (2 个参数)')
})

test('方法枚举：getter 不被触发', () => {
  let reads = 0
  const value = {
    hello(): void {},
    get danger(): number {
      reads += 1
      return 42
    },
  }

  const { methods } = collectMethods(value)
  assert.deepEqual(methods.map((method) => method.name), ['hello'])
  assert.equal(reads, 0, '枚举接口不应该产生副作用')
})

test('方法枚举：cordis 的 symbol 成员被排除，服务名与 ctx 不是方法', () => {
  class DemoService extends Service {
    constructor(ctx: Context) {
      super(ctx, 'demo')
    }

    ping(): string {
      return 'pong'
    }
  }

  const { methods, callable } = collectMethods(new DemoService(new Context()))
  const names = methods.map((method) => method.name)

  assert.deepEqual(names, ['ping'], `只该剩下 ping，实际 ${names.join(', ')}`)
  assert.equal(callable, false)
  for (const name of ['name', 'ctx', 'then']) assert.ok(!names.includes(name), `${name} 不是接口`)
})

test('可调用：函数与带 [symbols.invoke] 的对象都算', () => {
  assert.equal(collectMethods(() => undefined).callable, true)
  assert.equal(collectMethods({ [symbols.invoke]: () => 'x' }).callable, true)
  assert.equal(collectMethods({}).callable, false)
  assert.equal(collectMethods(null).callable, false)
  assert.equal(collectMethods('text').callable, false)
})

test('插件计数按状态分组', () => {
  const nodes = [
    { state: 'active' },
    { state: 'active' },
    { state: 'disabled' },
    { state: 'failed' },
  ] as unknown as AdminPluginNode[]
  const counts = pluginCounts(nodes)

  assert.equal(counts.active, 2)
  assert.equal(counts.disabled, 1)
  assert.equal(counts.failed, 1)
  assert.equal(counts.pending, 0)
  assert.equal(counts.unloaded, 0)
})
