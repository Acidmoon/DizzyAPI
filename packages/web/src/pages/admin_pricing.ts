/** 管理台 · 模型价格：列表与设置。 */
import { pageHeader, renderAdminShell, type PageModule } from '../layout.ts'
import { requiredString, WebError } from '../forms.ts'
import { WEB_ACTOR } from '../runtime.ts'

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
    const rows = list.map((price) => [
      t.escapeText(price.model),
      t.escapeText(price.inputPerMillion),
      t.escapeText(price.outputPerMillion),
      t.escapeText(price.cacheReadPerMillion),
      t.escapeText(price.cacheWritePerMillion),
      t.escapeText(price.updatedAt.slice(0, 10)),
    ])
    return renderAdminShell(ctx, [
      pageHeader(ctx, '模型价格', '单价单位：元 / 每百万 token。费用在读取用量时按这张表计算。'),
      t.renderTable({
        columns: [
          { label: '模型' },
          { label: '输入', align: 'right' },
          { label: '输出', align: 'right' },
          { label: '缓存读', align: 'right' },
          { label: '缓存写', align: 'right' },
          { label: '更新' },
        ],
        rows,
        empty: '还没有价格',
      }),
      t.renderSectionTitle('设置价格'),
      `<form class="form" method="post" action="/admin/pricing?action=set">
<div class="row">
${t.renderField({ label: '模型', name: 'model', required: true, placeholder: 'deepseek-chat' })}
${t.renderField({ label: '输入价', name: 'inputPerMillion', required: true, placeholder: '2' })}
${t.renderField({ label: '输出价', name: 'outputPerMillion', required: true, placeholder: '8' })}
${t.renderField({ label: '缓存读价', name: 'cacheReadPerMillion', placeholder: '0.5' })}
${t.renderField({ label: '缓存写价', name: 'cacheWritePerMillion', placeholder: '0' })}
<div class="actions"><button class="btn" type="submit">保存</button></div>
</div>
</form>`,
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
      await pricing.set(WEB_ACTOR, model, {
        inputPerMillion,
        outputPerMillion,
        ...(cacheReadPerMillion === undefined ? {} : { cacheReadPerMillion }),
        ...(cacheWritePerMillion === undefined ? {} : { cacheWritePerMillion }),
      })
      return '/admin/pricing?ok=' + encodeURIComponent('价格已保存')
    },
  },
}
