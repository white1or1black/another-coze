import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { SiteCollection, SiteDataItem } from '../lib/types'

/** 站点数据面板:查看/管理生成页面通过平台数据接口收集的访问者数据 */
export default function DataPanel({ projectId }: { projectId: string }) {
  const [collections, setCollections] = useState<SiteCollection[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [items, setItems] = useState<SiteDataItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadCollections = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await api<{ collections: SiteCollection[] }>(`/api/projects/${projectId}/data`)
      setCollections(data.collections)
      // 当前选中的集合若已不存在(被清空后列表仍可能显示 0 行,不清空选择),保持界面稳定
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  const openCollection = useCallback(async (name: string) => {
    setSelected(name)
    setError('')
    try {
      const data = await api<{ items: SiteDataItem[] }>(`/api/projects/${projectId}/data/${name}`)
      setItems(data.items)
    } catch (err) {
      setItems([])
      setError((err as Error).message)
    }
  }, [projectId])

  useEffect(() => {
    loadCollections()
  }, [loadCollections])

  async function deleteRow(rowId: string) {
    if (!selected || !confirm('删除这条数据?')) return
    try {
      await api(`/api/projects/${projectId}/data/${selected}/${rowId}`, { method: 'DELETE' })
      setItems((list) => list.filter((i) => i.id !== rowId))
      loadCollections()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function clearCollection() {
    if (!selected || !confirm(`清空「${selected}」的全部数据?此操作不可恢复。`)) return
    try {
      await api(`/api/projects/${projectId}/data/${selected}`, { method: 'DELETE' })
      setItems([])
      loadCollections()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (loading) return <div className="p-4 text-sm text-gray-500">加载中…</div>

  return (
    <div className="mx-auto max-w-3xl p-4">
      {error && <div className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>}

      {collections.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-700 p-8 text-center text-sm text-gray-500">
          暂无站点数据
          <div className="mt-1 text-xs text-gray-600">当页面调用平台数据接口(如留言板、报名表)后,访问者提交的数据会出现在这里</div>
        </div>
      ) : (
        <div className="flex gap-4">
          <div className="w-48 shrink-0 space-y-1">
            {collections.map((col) => (
              <button
                key={col.collection}
                onClick={() => openCollection(col.collection)}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm ${
                  selected === col.collection ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
                }`}
              >
                <span className="truncate font-mono text-xs">{col.collection}</span>
                <span className="ml-2 shrink-0 rounded-full bg-gray-700 px-2 py-0.5 text-xs text-gray-300">{col.count}</span>
              </button>
            ))}
          </div>

          <div className="min-w-0 flex-1">
            {selected ? (
              <>
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-mono text-xs text-gray-400">{selected}</span>
                  <button
                    onClick={clearCollection}
                    className="rounded-lg border border-red-500/40 px-2 py-1 text-xs text-red-400 hover:bg-red-500/10"
                  >
                    清空集合
                  </button>
                </div>
                {items.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-gray-700 p-6 text-center text-xs text-gray-500">
                    该集合暂无数据
                  </div>
                ) : (
                  <div className="space-y-2">
                    {items.map((item) => (
                      <div key={item.id} className="rounded-xl border border-gray-800 bg-gray-950 p-3 text-xs">
                        <div className="mb-1 flex items-center justify-between text-gray-600">
                          <span>{item.created_at}</span>
                          <button onClick={() => deleteRow(item.id)} className="text-red-400/70 hover:text-red-400">
                            删除
                          </button>
                        </div>
                        <pre className="overflow-auto whitespace-pre-wrap break-all font-mono leading-5 text-gray-300">
                          {JSON.stringify(item.data, null, 2)}
                        </pre>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="rounded-xl border border-dashed border-gray-700 p-6 text-center text-xs text-gray-500">
                选择左侧集合查看数据
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
