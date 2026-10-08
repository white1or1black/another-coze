import { useState } from 'react'
import DataPanel from './DataPanel'
import type { Project } from '../lib/types'

interface Props {
  html: string | null
  streaming: boolean
  /** 生成进行中的阶段文案(含已用时间),如"正在编写页面代码 · 已 45s" */
  progressText: string
  project: Project | null
  onPublish: () => void
}

export default function PreviewPane({ html, streaming, progressText, project, onPublish }: Props) {
  const [tab, setTab] = useState<'preview' | 'code' | 'data'>('preview')
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop')
  const published = project?.status === 'published'
  const publicUrl = project ? `${location.origin}/s/${project.slug}` : ''
  // 预览 iframe 是 srcDoc opaque origin,数据接口占位符替换为绝对地址指向宿主 origin;
  // /draft 环境段:预览中提交的数据进草稿库,与发布后访客产生的线上数据隔离;
  // 存储的 HTML 保留占位符(origin 与环境无关),发布服务端会替换为 /live
  const previewHtml = html && project ? html.split('__FORGE_API__').join(`${location.origin}/api/site/${project.slug}/draft`) : html

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-gray-900">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-gray-800 px-3">
        <div className="flex gap-1">
          {(['preview', 'code', 'data'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-lg px-3 py-1.5 text-sm ${
                tab === t ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {t === 'preview' ? '预览' : t === 'code' ? '代码' : '数据'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {tab === 'preview' && (
            <div className="flex rounded-lg border border-gray-700 p-0.5 text-xs">
              {(['desktop', 'mobile'] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setDevice(d)}
                  className={`rounded-md px-2 py-1 ${device === d ? 'bg-gray-700 text-white' : 'text-gray-400'}`}
                >
                  {d === 'desktop' ? '桌面' : '移动'}
                </button>
              ))}
            </div>
          )}
          {published && (
            <a
              href={publicUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-emerald-500/40 px-3 py-1.5 text-xs text-emerald-400 hover:bg-emerald-500/10"
            >
              查看公开页
            </a>
          )}
          <button
            onClick={onPublish}
            disabled={published || !html}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
          >
            {published ? '已发布' : '发布'}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {tab === 'data' ? (
          project ? (
            <DataPanel projectId={project.id} />
          ) : null
        ) : tab === 'preview' ? (
          <div className={`mx-auto h-full ${device === 'mobile' ? 'w-[390px]' : 'w-full'}`}>
            {previewHtml ? (
              <iframe
                title="preview"
                srcDoc={previewHtml}
                sandbox="allow-scripts allow-forms allow-popups"
                className="h-full min-h-[600px] w-full rounded-xl border border-gray-700 bg-white"
              />
            ) : (
              <div className="flex h-full min-h-[400px] flex-col items-center justify-center gap-2 text-sm text-gray-500">
                {streaming ? (
                  <>
                    <span className="flex items-center gap-2">
                      <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
                      {progressText || '正在生成页面…'}
                    </span>
                    <span className="text-xs text-gray-600">逐章生成约需 3~10 分钟;可离开页面,云端会继续完成</span>
                  </>
                ) : (
                  '暂无预览,在左侧描述你的想法开始生成'
                )}
              </div>
            )}
          </div>
        ) : (
          <pre className="h-full min-h-[400px] overflow-auto rounded-xl bg-gray-950 p-4 font-mono text-xs leading-5 text-emerald-300">
            {html ?? '// 暂无代码'}
          </pre>
        )}
      </div>
    </section>
  )
}
