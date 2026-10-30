/**
 * 管理台 · 模型价格：列表 + 「编辑」弹窗 + 「添加模型」。
 *
 * owner 第 10 条：操作收进编辑弹窗，并新增「添加模型」按钮；**标出未定价 = 不可请求**。
 *
 * 「未定价不可请求」的实现方式是 Go 的定价闸门（`-pricing-gate` 打开后返回
 * 403 `MODEL_NOT_PRICED`）。闸门**默认关**，所以页面上要写清「闸门关时仍可请求」，
 * 不能让运维以为现在就已经拦住了。
 *
 * 未定价的模型从 `modelhub.catalog()` 拿（账号声明了但价格表里没有的那些）——
 * 价格表本身只能列出「已定价」的，光看它永远发现不了缺价。
 *
 * 无 JS 降级：「编辑 / 添加」在无脚本时是普通链接（`?edit=<model>` / `?add=1`），
 * 点了渲染整页表单。
 */
import { pageHeader, renderAdminShell, type PageContext, type PageModule } from '../layout.ts'
import { requiredString, WebError } from '../forms.ts'
import { WEB_ACTOR } from '../runtime.ts'
import { auditedAction } from '../audit.ts'

/** 一个模型的价格（列表与表单共用）。 */
interface PriceRow {
  readonly model: string
  readonly inputPerMillion: string
  readonly outputPerMillion: string
  readonly cacheReadPerMillion: string
  readonly cacheWritePerMillion: string
  readonly updatedAt: string
}

/** 价格表单：`action` 决定是「改已有」还是「新建」，字段完全一样。 */
function renderPriceForm(
  t: PageContext['t'],
  action: string,
  price: PriceRow | undefined,
): string {
  // 新建时模型名可填；编辑时模型名是主键，锁死（改名等于新建 + 删旧，页面上不做）。
  const modelField = price === undefined
    ? t.renderField({ label: '模型', name: 'model', required: true, placeholder: 'deepseek-chat' })
    : `<input type="hidden" name="model" value="${t.escapeAttr(price.model)}">
${t.renderField({ label: '模型（主键，不可改）', name: 'modelDisplay', value: price.model, hint: '换名等于新建一条 + 删旧，请新建后再删旧。' })}`
  return `<form class="form form--wide" method="post" action="${action}">
${modelField}
${t.renderField({
  label: '输入价（元 / 百万 token）',
  name: 'inputPerMillion',
  value: price?.inputPerMillion ?? '',
  required: true,
  placeholder: '2',
})}
${t.renderField({
  label: '输出价（元 / 百万 token）',
  name: 'outputPerMillion',
  value: price?.outputPerMillion ?? '',
  required: true,
  placeholder: '8',
})}
${t.renderField({
  label: '缓存读价（元 / 百万 token）',
  name: 'cacheReadPerMillion',
  value: price?.cacheReadPerMillion ?? '',
  placeholder: '0.5',
  hint: '留空 = 0。',
})}
${t.renderField({
  label: '缓存写价（元 / 百万 token）',
  name: 'cacheWritePerMillion',
  value: price?.cacheWritePerMillion ?? '',
  placeholder: '0',
  hint: '留空 = 0。',
})}
<div class="actions"><button class="btn" type="submit">保存</button></div>
</form>`
}

export const adminPricingPage: PageModule = {
  path: '/admin/pricing',
  area: 'admin',
  title: '模型价格',
  auth: true,
  admin: true,

  async render(ctx) {
    const t = ctx.t
    const pricing = ctx.services.pricing
    if (pricing === undefined) {
      return renderAdminShell(ctx, pageHeader(ctx, '模型价格') + t.renderNotice({ kind: 'err', text: '价格服务未运行' }))
    }
    const list = pricing.list()

    // 未定价的模型只可能从「账号声明了什么」那边发现，价格表里永远没有它们。
    let unpriced: readonly string[] = []
    const modelhub = ctx.services.modelhub
    if (modelhub !== undefined) {
      try {
        const catalog = modelhub.catalog({ priced: 'unpriced' })
        unpriced = [...catalog.available, ...catalog.unavailable].map((item) => item.model)
      } catch {
        // 模型广场缺席 / 查询失败只少一块提示，不影响价格表本身
      }
    }

    const rows = list.map((price) => {
      const edit = `<a class="btn small" href="/admin/pricing?edit=${encodeURIComponent(price.model)}"${t.dialogOpenAttr(`price-edit-${price.model}`)}>编辑</a>`
      const remove = `<form class="inline-form" method="post" action="/admin/pricing?action=remove" data-confirm="删除后该模型变成「未定价」：定价闸门打开时会被拒绝。确定？">
<input type="hidden" name="model" value="${t.escapeAttr(price.model)}">
<button class="btn small danger" type="submit">删除</button></form>`
      return [
        t.escapeText(price.model),
        t.escapeText(price.inputPerMillion),
        t.escapeText(price.outputPerMillion),
        t.escapeText(price.cacheReadPerMillion),
        t.escapeText(price.cacheWritePerMillion),
        t.escapeText(price.updatedAt.slice(0, 10)),
        `<div class="actions">${edit}${remove}</div>`,
      ]
    })

    const unpricedRows = unpriced.map((model) => [
      t.escapeText(model),
      t.renderBadge('未定价', 'warn'),
      `<a class="btn small" href="/admin/pricing?add=1&model=${encodeURIComponent(model)}"${t.dialogOpenAttr('price-add')}>补价格</a>`,
    ])

    // 无脚本降级：`?edit=<model>` 与 `?add=1` 各渲染一张整页表单。
    const editTarget = ctx.query.get('edit')
    const editing = editTarget === null ? undefined : list.find((price) => price.model === editTarget)
    const isAdd = ctx.query.get('add') !== null
    const prefilled = ctx.query.get('model')
    const inlineForm = editing !== undefined
      ? `${t.renderSectionTitle(`编辑价格：${editing.model}`)}
${renderPriceForm(t, '/admin/pricing?action=set', editing)}`
      : isAdd
        ? `${t.renderSectionTitle('添加模型价格')}
${renderPriceForm(t, '/admin/pricing?action=set', prefilled === null ? undefined : {
          model: prefilled,
          inputPerMillion: '',
          outputPerMillion: '',
          cacheReadPerMillion: '',
          cacheWritePerMillion: '',
          updatedAt: '',
        })}`
        : ''

    // 弹窗：每行一个编辑弹窗 + 一个添加弹窗。
    const modals = [
      ...list.map((price) =>
        t.renderModal({
          id: `price-edit-${price.model}`,
          title: `编辑价格：${price.model}`,
          size: 'wide',
          bodyHtml: renderPriceForm(t, '/admin/pricing?action=set', price),
        }),
      ),
      t.renderModal({
        id: 'price-add',
        title: '添加模型价格',
        size: 'wide',
        bodyHtml: renderPriceForm(t, '/admin/pricing?action=set',
          prefilled === null ? undefined : {
            model: prefilled,
            inputPerMillion: '',
            outputPerMillion: '',
            cacheReadPerMillion: '',
            cacheWritePerMillion: '',
            updatedAt: '',
          }),
      }),
    ]

    const gateNote = `<p class="hint p--spaced">未定价的模型在<b>打开 <code class="mono">-pricing-gate</code> 之后</b>会被直接拒绝（403 <code class="mono">MODEL_NOT_PRICED</code>，不转发上游）；闸门默认关，现在仍可请求。</p>`

    return renderAdminShell(ctx, [
      pageHeader(ctx, '模型价格', '单价单位：元 / 每百万 token。费用在读取用量时按这张表计算。'),
      inlineForm,
      `<div class="actions form--spaced">
<a class="btn" href="/admin/pricing?add=1"${t.dialogOpenAttr('price-add')}>添加模型</a>
</div>`,
      gateNote,
      t.renderTable({
        columns: [
          { label: '模型' },
          { label: '输入', align: 'right' },
          { label: '输出', align: 'right' },
          { label: '缓存读', align: 'right' },
          { label: '缓存写', align: 'right' },
          { label: '更新' },
          { label: '操作' },
        ],
        rows,
        empty: '还没有价格',
      }),
      t.renderSectionTitle('未定价的模型（不可请求）'),
      t.renderTable({
        columns: [{ label: '模型' }, { label: '状态' }, { label: '操作' }],
        rows: unpricedRows,
        empty: '账号声明过的模型都有价格',
      }),
      ...modals,
    ].join('\n'))
  },

  actions: {
    set: async (ctx) => {
      const pricing = ctx.services.pricing
      if (pricing === undefined) throw new WebError('WEB_NO_PRICING', '价格服务未运行')
      const model = requiredString(ctx.form, 'model', '模型')
      const inputPerMillion = requiredString(ctx.form, 'inputPerMillion', '输入价')
      const outputPerMillion = requiredString(ctx.form, 'outputPerMillion', '输出价')
      const cacheReadPerMillion = ctx.form.get('cacheReadPerMillion')?.trim() || undefined
      const cacheWritePerMillion = ctx.form.get('cacheWritePerMillion')?.trim() || undefined
      await auditedAction(
        ctx,
        {
          action: 'pricing.write',
          targetType: 'pricing',
          targetId: model,
          summary: `写入模型 ${model} 的价格`,
          metadata: { inputPerMillion, outputPerMillion },
        },
        () =>
          pricing.set(WEB_ACTOR, model, {
            inputPerMillion,
            outputPerMillion,
            ...(cacheReadPerMillion === undefined ? {} : { cacheReadPerMillion }),
            ...(cacheWritePerMillion === undefined ? {} : { cacheWritePerMillion }),
          }),
      )
      return '/admin/pricing?ok=' + encodeURIComponent('价格已保存')
    },

    remove: async (ctx) => {
      const pricing = ctx.services.pricing
      if (pricing === undefined) throw new WebError('WEB_NO_PRICING', '价格服务未运行')
      const model = requiredString(ctx.form, 'model', '模型')
      await auditedAction(
        ctx,
        {
          action: 'pricing.remove',
          targetType: 'pricing',
          targetId: model,
          summary: `删除模型 ${model} 的价格（该模型变为未定价）`,
        },
        () => pricing.remove(WEB_ACTOR, model),
      )
      return '/admin/pricing?ok=' + encodeURIComponent('价格已删除')
    },
  },
}
