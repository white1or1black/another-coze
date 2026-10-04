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
要求:sections 为 3-6 个;palette 提供 3-4 个和谐的 hex 颜色;全程使用简体中文。`,
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
