import type { Plan } from '../types'
import type { ChatMessage } from './llm'

/** 阶段 1:把想法变成结构化规划(严格 JSON) */
export function planMessages(idea: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `你是一位资深产品规划师。用户会给出一个网站想法,你输出一份简洁的建站规划。
严格输出如下 JSON,不要输出 JSON 以外的任何文字,不要使用代码块:
{"name":"网站名,10字以内","tagline":"一句话定位","palette":["#主色","#辅色","#强调色","#文字色"],"sections":[{"title":"章节标题","summary":"该章节内容简述"}]}
要求:sections 为 3-5 个;palette 提供 3-4 个和谐的 hex 颜色;全程使用简体中文。`,
    },
    { role: 'user', content: `网站想法:${idea}` },
  ]
}

/** 阶段 2:按规划生成完整单文件 HTML */
export function codeMessages(idea: string, plan: Plan): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `你是一位顶级前端工程师,负责根据规划生成完整可运行的静态网页。严格遵守:
1. 只输出一个完整的 index.html 文件内容,以 <!DOCTYPE html> 开头、</html> 结尾;不要输出任何解释或 markdown 代码块。
2. 用 <script src="https://cdn.tailwindcss.com"></script> 引入 Tailwind CSS,样式全部使用 Tailwind 工具类。
3. 全部文案使用简体中文;布局响应式,手机与桌面都美观。
4. 禁止引用任何外部图片;视觉元素用 CSS 渐变、内联 SVG、emoji 和色块构成。
5. 内容必须真实可信:围绕主题编写具体文案与贴近真实的中文示例数据(如商品名、价格、评价、文章标题),禁止 lorem ipsum 或"示例文字"占位。
6. 用原生 JavaScript 实现页面内基本交互(导航高亮、标签页切换、轮播、表单校验与提交提示、FAQ 折叠等),脚本内联在页面底部。
7. 按给定章节规划组织页面结构,配色使用给定调色板,风格统一精致。
8. 若想法需要保存访问者提交的数据(留言板、报名表、评论、点赞、计数器等),调用平台内置数据接口,无需任何密钥:
   - 写入:fetch('__FORGE_API__/<集合名>', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({字段:值}) }),成功返回 {"id":"..."}
   - 读取:fetch('__FORGE_API__/<集合名>'),返回 {"items":[{"id","data","created_at"}]},data 即写入的 JSON
   - 页面加载时先读取并渲染已有数据,提交成功后重新拉取刷新列表;请求失败时给出友好提示,不要让页面报错。
   - 集合名用小写英文单词(如 guestbook、signups);只保存访问者主动提交或页面运行产生的数据,禁止收集密码、支付信息等敏感内容。纯展示型页面不要调用该接口。`,
    },
    { role: 'user', content: `网站想法:${idea}\n\n建站规划:\n${JSON.stringify(plan, null, 2)}` },
  ]
}

/**
 * 分段生成上限:章节再多也只构建前 N 段。模型网关对长单请求不稳定(实测 200~400s 即可能 5xx/断流),
 * 每段控制在 1~2 分钟内完成;与规划阶段的 sections 上限(3-6 个)一致。
 */
export const MAX_SEGMENTS = 6

/** 章节占位符(骨架中独占一行,分段组装时被替换) */
export function sectionPlaceholder(index: number): string {
  return `<!--FORGE:SECTION:${index}-->`
}

/** 分段第一步:生成页面骨架(完整文档,正文只含章节占位符) */
export function shellMessages(idea: string, plan: Plan): ChatMessage[] {
  const list = plan.sections
    .slice(0, MAX_SEGMENTS)
    .map((s, i) => `编号 ${i}:${s.title} —— ${s.summary}`)
    .join('\n')
  return [
    {
      role: 'system',
      content: `你是一位顶级前端工程师,负责为单文件网站生成「页面骨架」。这是分段构建的第一步,各章节正文由后续步骤单独生成并替换对应占位符。严格遵守:
1. 只输出一个完整的 index.html 文档:以 <!DOCTYPE html> 开头、</html> 结尾;不要输出解释或 markdown 代码块。
2. <head> 内用 <script src="https://cdn.tailwindcss.com"></script> 引入 Tailwind CSS,自定义样式(CSS 变量、渐变、关键动画)写在 <style> 内,配色使用给定调色板,风格统一精致。
3. <body> 结构:页头导航(站点名 + 锚点菜单)、各章节占位符、页脚。每个章节占位符必须独占一行,格式严格为:
<!--FORGE:SECTION:编号-->
编号与下方章节列表一一对应,按顺序排列;占位符之外不要写任何章节正文。
4. 全局交互(导航高亮、滚动动效等)以内联 <script>(置于 </body> 前)实现;页脚写好版权信息。
5. 全部文案简体中文;布局响应式;禁止引用外部图片,视觉元素用 CSS 渐变、内联 SVG、emoji 和色块。
6. 骨架务必精炼,全文控制在 150 行以内;CSS 优先用 Tailwind 工具类,自定义样式只写关键部分。`,
    },
    {
      role: 'user',
      content: `网站想法:${idea}\n\n网站名:${plan.name}\n一句话定位:${plan.tagline}\n调色板:${plan.palette.join(', ')}\n\n章节列表(占位符编号以此为准):\n${list}`,
    },
  ]
}

/** 分段后续步骤:为单个章节生成正文片段 */
export function sectionMessages(idea: string, plan: Plan, index: number): ChatMessage[] {
  const s = plan.sections[index]
  return [
    {
      role: 'system',
      content: `你是一位顶级前端工程师,正在为单文件网站分段生成正文。本次只负责一个章节,输出会被原样替换进骨架的占位符位置。严格遵守:
1. 只输出该章节的 HTML 片段(如 <section id="...">...</section>),不要完整文档、不要解释、不要 markdown 代码块。
2. 样式用 Tailwind 工具类,配色遵循给定调色板,与骨架风格统一;内容真实具体,编写贴近真实的中文示例数据(如商品名、价格、评价、文章标题),禁止 lorem ipsum 或"示例文字"占位。
3. 片段控制在 70 行以内。
4. 章节自身的交互(标签页、轮播、表单校验、FAQ 折叠等)可在片段末尾用内联 <script> 以原生 JS 实现,注意避免全局命名冲突。
5. 若章节需要保存访问者提交的数据(留言板、报名、评论、点赞、计数器等),调用平台内置数据接口,无需任何密钥:
   - 写入:fetch('__FORGE_API__/<集合名>', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({字段:值}) }),成功返回 {"id":"..."}
   - 读取:fetch('__FORGE_API__/<集合名>'),返回 {"items":[{"id","data","created_at"}]},data 即写入的 JSON
   - 页面加载时先读取并渲染已有数据,提交成功后重新拉取刷新列表;请求失败时给出友好提示,不要让页面报错。
   - 集合名用小写英文单词(如 guestbook、signups);只保存访问者主动提交或页面运行产生的数据,禁止收集密码、支付信息等敏感内容。纯展示章节不要调用该接口。`,
    },
    {
      role: 'user',
      content: `网站想法:${idea}\n网站名:${plan.name}\n调色板:${plan.palette.join(', ')}\n\n本次负责的章节(编号 ${index}):\n标题:${s.title}\n内容简述:${s.summary}`,
    },
  ]
}

/** 迭代修改:输入当前 HTML + 修改要求,输出修改后的全量 HTML */
export function reviseMessages(currentHtml: string, requirement: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `你是一位顶级前端工程师,负责修改一个现有静态网页。严格遵守:
1. 输出修改后的完整 index.html(以 <!DOCTYPE html> 开头、</html> 结尾),不要输出解释或 markdown 代码块。
2. 只做用户要求的修改,其余文案、结构、风格尽量保持原样。
3. 修改后的页面仍须满足:Tailwind CDN、简体中文、响应式、无外部图片、内联原生 JS。
4. 若现有页面使用了 __FORGE_API__ 数据接口读写数据,保持调用方式与集合名原样保留,不要改动或删除相关代码。`,
    },
    { role: 'user', content: `当前完整 HTML:\n${currentHtml}\n\n修改要求:${requirement}` },
  ]
}

/** 从模型输出中解析规划 JSON,失败时返回兜底规划 */
export function parsePlan(text: string, fallbackIdea: string): Plan {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
      const palette = Array.isArray(raw.palette)
        ? (raw.palette as unknown[]).map(String).filter((c) => /^#[0-9a-f]{3,8}$/i.test(c))
        : []
      const sections = Array.isArray(raw.sections)
        ? (raw.sections as Record<string, unknown>[]).slice(0, 8).map((s) => ({
            title: String(s?.title ?? ''),
            summary: String(s?.summary ?? ''),
          }))
        : []
      return {
        name: String(raw.name || fallbackIdea.slice(0, 12)),
        tagline: String(raw.tagline || ''),
        palette: palette.length ? palette : ['#6366f1', '#a855f7', '#f59e0b', '#e5e7eb'],
        sections,
      }
    } catch {
      // 落到兜底
    }
  }
  return { name: fallbackIdea.slice(0, 12), tagline: '', palette: ['#6366f1', '#a855f7', '#f59e0b', '#e5e7eb'], sections: [] }
}

/** 提取首个 <html…到末尾 </html> 的完整 HTML;失败时原样返回(trim) */
export function extractHtml(text: string): string {
  const start = text.search(/<(!DOCTYPE|html)/i)
  const end = text.toLowerCase().lastIndexOf('</html>')
  if (start !== -1 && end !== -1 && end > start) return text.slice(start, end + 7)
  return text.trim()
}

/** 去掉模型可能添加的 markdown 代码块围栏,返回片段本体(trim) */
export function stripFence(text: string): string {
  const m = text.match(/```[a-zA-Z]*\s*\n([\s\S]*?)\n?```/)
  return (m ? m[1] : text).trim()
}

/** 计划项重试耗尽后的降级占位块:页面照常交付,用户可在对话中要求补全 */
export function fallbackSectionHtml(title: string, palette: string[]): string {
  const accent = palette[2] ?? palette[0] ?? '#6366f1'
  return `<section class="py-20 px-6">
  <div class="mx-auto max-w-3xl rounded-2xl border p-10 text-center" style="border-color:${accent}33;background:${accent}0d;">
    <h2 class="text-2xl font-bold mb-3">${title}</h2>
    <p class="text-sm opacity-70">该板块生成时模型服务暂时不可用。你可以在左侧对话中输入「重新生成${title}」,补全这一部分。</p>
  </div>
</section>`
}
